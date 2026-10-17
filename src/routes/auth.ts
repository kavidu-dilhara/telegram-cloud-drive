import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { allowedOrigins, config } from "../config.ts";
import { db, logAction } from "../db.ts";
import { type AppEnv, type Ctx, fail, jsonBody } from "../http.ts";
import { maybeRunMaintenance } from "../maintenance.ts";
import {
  clearFailures,
  clientIp,
  isLimited,
  type LimitRule,
  recordFailure,
  ThrottleUnavailableError,
} from "../rateLimit.ts";
import {
  burnPasswordCheck,
  createSession,
  FRESH_TELEGRAM_MS,
  hashPassword,
  passwordProblem,
  PBKDF2_ITERATIONS,
  type SessionMethod,
  verifyMiniAppInitData,
  verifyPassword,
  verifySession,
} from "../security.ts";

const COOKIE = "drive_session";
const loginName = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9._-]{3,64}$/.test(value);

/** A ready response when the attempt must be refused: limit reached (429) or throttling unavailable (503). */
async function throttleBlock(
  c: import("hono").Context,
  rules: LimitRule[],
  tooMany: string,
): Promise<Response | null> {
  try {
    if (!await isLimited(rules)) return null;
    c.header("Retry-After", "900");
    return fail(c, tooMany, 429);
  } catch (error) {
    if (!(error instanceof ThrottleUnavailableError)) throw error;
    c.header("Retry-After", "60");
    return fail(
      c,
      "Sign-in is temporarily unavailable. Try again in a minute, or open Cloud Drive from Telegram.",
      503,
    );
  }
}

const setSessionCookie = (c: Ctx | import("hono").Context, token: string) =>
  c.header(
    "Set-Cookie",
    `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=43200`,
  );
const clearSessionCookie = (c: Ctx | import("hono").Context) =>
  c.header("Set-Cookie", `${COOKIE}=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0`);

// ---- session version (revocation) ------------------------------------------
// Read from the database on every check, never cached: "sign out everywhere" and credential changes must
// take effect on every backend instance immediately.

/** Thrown when the session version cannot be read, so callers refuse instead of guessing. */
export class SessionStoreUnavailableError extends Error {
  constructor(message = "Session version is unavailable") {
    super(message);
    this.name = "SessionStoreUnavailableError";
  }
}

export async function currentSessionVersion(): Promise<number> {
  const { data, error } = await db.from("users").select("session_version").eq("telegram_id", config.ownerId)
    .maybeSingle();
  if (error) {
    console.error("Unable to read the session version", error.message);
    throw new SessionStoreUnavailableError();
  }
  return Number(data?.session_version ?? 1);
}

async function bumpSessionVersion(): Promise<number> {
  const next = (await currentSessionVersion()) + 1;
  const { error } = await db.from("users").update({ session_version: next }).eq(
    "telegram_id",
    config.ownerId,
  );
  if (error) throw error;
  return next;
}

async function issueSession(c: import("hono").Context, via: SessionMethod, version?: number) {
  const token = await createSession(config.ownerId, version ?? await currentSessionVersion(), via);
  setSessionCookie(c, token);
  return token;
}

interface OwnerRow {
  telegram_id: number;
  login_username: string | null;
  password_hash: string | null;
  password_salt: string | null;
  password_iterations: number | null;
  password_enabled: boolean;
}

const ownerRow = async () => {
  const { data } = await db.from("users").select(
    "telegram_id,login_username,password_hash,password_salt,password_iterations,password_enabled",
  ).eq("telegram_id", config.ownerId).maybeSingle();
  return data as OwnerRow | null;
};

// ---- middleware --------------------------------------------------------------

/** Rejects browser requests from any origin other than the Mini App (and the optional dev origin). */
export const originGuard: MiddlewareHandler = async (c, next) => {
  const origin = c.req.header("Origin");
  if (origin && !allowedOrigins.includes(origin)) return fail(c, "Forbidden origin", 403);
  await next();
};

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const bearer = c.req.header("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const rawCookie = c.req.header("Cookie")?.match(/(?:^|;\s*)drive_session=([^;]+)/)?.[1];
  let cookie: string | undefined;
  try {
    cookie = rawCookie ? decodeURIComponent(rawCookie) : undefined;
  } catch {
    cookie = undefined;
  }
  const token = bearer ?? cookie;
  const claims = token ? await verifySession(token) : null;
  if (!claims) return fail(c, "Unauthorized", 401);
  try {
    if (claims.v !== await currentSessionVersion()) return fail(c, "Unauthorized", 401);
  } catch (error) {
    if (!(error instanceof SessionStoreUnavailableError)) throw error;
    c.header("Retry-After", "5");
    return fail(c, "Unable to verify your session right now. Try again in a moment.", 503);
  }
  c.set("session", claims);
  maybeRunMaintenance();
  await next();
};

// ---- public routes -------------------------------------------------------------

export const publicAuth = new Hono<AppEnv>();

publicAuth.get("/method", async (c) => {
  const row = await ownerRow();
  return c.json({ password_enabled: Boolean(row?.password_enabled && row.login_username) });
});

publicAuth.post("/telegram", async (c) => {
  try {
    const body = await jsonBody<{ initData?: unknown }>(c);
    if (!body || typeof body.initData !== "string") return fail(c, "Invalid authentication payload");
    const user = await verifyMiniAppInitData(body.initData);
    const { error } = await db.from("users").upsert(
      { telegram_id: user.id, username: user.username ?? null, first_name: user.first_name ?? null },
      { onConflict: "telegram_id" },
    );
    if (error) console.error("Unable to update Telegram user profile", error.message);
    const token = await issueSession(c, "telegram");
    return c.json({ ok: true, token });
  } catch {
    return fail(c, "Telegram authentication failed", 401);
  }
});

publicAuth.post("/password/login", async (c) => {
  const body = await jsonBody<{ username?: unknown; password?: unknown }>(c);
  if (
    !body || !loginName(body.username) || typeof body.password !== "string" || !body.password ||
    body.password.length > 256
  ) {
    return fail(c, "Enter a valid username and password");
  }
  const username = body.username.toLowerCase();
  const ip = clientIp(c);
  const keys = [`user:${username}`, `ip:${ip}`, "global"];
  const rules = [{ key: keys[0], max: 10 }, { key: keys[1], max: 10 }, { key: keys[2], max: 40 }];
  const blocked = await throttleBlock(
    c,
    rules,
    "Too many sign-in attempts. Try again in 15 minutes, or open Cloud Drive from Telegram.",
  );
  if (blocked) return blocked;

  const row = await ownerRow();
  const known = Boolean(
    row?.password_enabled && row.password_hash && row.password_salt && row.login_username === username,
  );
  let valid = false;
  if (known && row) {
    valid = await verifyPassword(
      body.password,
      row.password_salt!,
      row.password_hash!,
      row.password_iterations ?? 210_000,
    );
  } else {
    await burnPasswordCheck(body.password);
  }
  if (!valid || !row) {
    await recordFailure(keys);
    return fail(c, "Invalid username or password", 401);
  }

  await clearFailures([keys[0], keys[1]]);
  if ((row.password_iterations ?? 210_000) < PBKDF2_ITERATIONS) {
    // Silently upgrade older hashes to the current work factor.
    const upgraded = await hashPassword(body.password);
    await db.from("users").update({
      password_hash: upgraded.hash,
      password_salt: upgraded.salt,
      password_iterations: upgraded.iterations,
    }).eq("telegram_id", config.ownerId);
  }
  const token = await issueSession(c, "password");
  await logAction("sign_in", undefined, { method: "password" });
  return c.json({ ok: true, token });
});

publicAuth.post("/logout", (c) => {
  clearSessionCookie(c);
  return c.json({ ok: true });
});

// ---- routes that need a session ------------------------------------------------

export const privateAuth = new Hono<AppEnv>();

privateAuth.get("/me", async (c) => {
  const claims = c.get("session");
  const row = await ownerRow();
  const fresh = claims.via === "telegram" && Date.now() - claims.iat < FRESH_TELEGRAM_MS;
  return c.json({
    authenticated: true,
    via: claims.via,
    password_enabled: Boolean(row?.password_enabled),
    username: row?.login_username ?? null,
    can_change_without_current_password: fresh,
    session_expires_at: new Date(claims.exp).toISOString(),
  });
});

privateAuth.post("/logout-all", async (c) => {
  await bumpSessionVersion();
  clearSessionCookie(c);
  await logAction("sign_out_everywhere");
  return c.json({ ok: true });
});

async function saveCredentials(c: Ctx, username: string, password: string) {
  const credentials = await hashPassword(password);
  const version = (await currentSessionVersion()) + 1;
  const { error } = await db.from("users").update({
    login_username: username,
    password_hash: credentials.hash,
    password_salt: credentials.salt,
    password_iterations: credentials.iterations,
    password_enabled: true,
    session_version: version,
  }).eq("telegram_id", config.ownerId);
  if (error) {
    return error.code === "23505"
      ? fail(c, "That username is already taken", 409)
      : fail(c, "Unable to save browser credentials", 500);
  }
  // Every older session is revoked; the current device gets a fresh one.
  const token = await issueSession(c, c.get("session").via, version);
  return { token };
}

privateAuth.post("/password/setup", async (c) => {
  const body = await jsonBody<{ username?: unknown; password?: unknown }>(c);
  if (!body || !loginName(body.username)) {
    return fail(c, "Username must be 3-64 characters: letters, numbers, dot, dash or underscore");
  }
  const problem = passwordProblem(body.password);
  if (problem) return fail(c, problem);
  if ((await ownerRow())?.password_enabled) {
    return fail(c, "Browser sign-in is already enabled. Use Change credentials instead.", 409);
  }
  const result = await saveCredentials(c, body.username.toLowerCase(), body.password as string);
  if (result instanceof Response) return result;
  await logAction("password_setup", undefined, { username: body.username.toLowerCase() });
  return c.json({ ok: true, token: result.token });
});

privateAuth.patch("/password", async (c) => {
  const body = await jsonBody<{ username?: unknown; password?: unknown; current_password?: unknown }>(c);
  if (!body || !loginName(body.username)) {
    return fail(c, "Username must be 3-64 characters: letters, numbers, dot, dash or underscore");
  }
  const problem = passwordProblem(body.password);
  if (problem) return fail(c, problem);

  const row = await ownerRow();
  if (!row?.password_enabled || !row.password_hash || !row.password_salt) {
    return fail(c, "Browser sign-in is not enabled yet", 409);
  }

  const claims = c.get("session");
  const freshTelegram = claims.via === "telegram" && Date.now() - claims.iat < FRESH_TELEGRAM_MS;
  if (!freshTelegram) {
    const limitKey = "pwchange";
    const blocked = await throttleBlock(
      c,
      [{ key: limitKey, max: 5 }],
      "Too many attempts. Try again in 15 minutes.",
    );
    if (blocked) return blocked;
    const ok = typeof body.current_password === "string" &&
      await verifyPassword(
        body.current_password,
        row.password_salt,
        row.password_hash,
        row.password_iterations ?? 210_000,
      );
    if (!ok) {
      await recordFailure([limitKey]);
      return fail(c, "Current password is incorrect", 403);
    }
    await clearFailures([limitKey]);
  }

  const result = await saveCredentials(c, body.username.toLowerCase(), body.password as string);
  if (result instanceof Response) return result;
  await logAction("password_change", undefined, { username: body.username.toLowerCase() });
  return c.json({ ok: true, token: result.token });
});
