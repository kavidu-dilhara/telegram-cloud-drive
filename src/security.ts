import { config } from "./config.ts";
import { base64UrlDecode, base64UrlEncode, safeEqualText, timingSafeEqual, toHex } from "./lib.ts";

const enc = new TextEncoder();

/** PBKDF2-HMAC-SHA256 work factor for new hashes (OWASP guidance). */
export const PBKDF2_ITERATIONS = 600_000;
export const SESSION_LIFETIME_MS = 12 * 3600_000;
/** How recently the owner must have opened the Mini App for changes that create or replace credentials. */
export const RECENT_SIGNIN_MS = 10 * 60_000;
/** Telegram keeps the launch data of a Mini App that stays open or minimised, so allow a full day. */
export const INIT_DATA_MAX_AGE_SECONDS = 24 * 3600;

async function hmac(key: Uint8Array<ArrayBuffer> | string, message: string) {
  const rawKey = typeof key === "string" ? enc.encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey("raw", rawKey, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message)));
}

export interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
  /** When the Mini App was launched (Telegram's auth_date), in seconds since epoch. */
  auth_date: number;
}

/** Validates Telegram Mini App initData and returns the owner. Throws on any problem. */
export async function verifyMiniAppInitData(
  initData: string,
  botToken = config.botToken,
  ownerId = config.ownerId,
): Promise<TelegramUser> {
  if (!initData || initData.length > 8192) throw new Error("Invalid Telegram initData");
  const params = new URLSearchParams(initData);
  const hash = params.get("hash")?.toLowerCase();
  const authDate = Number(params.get("auth_date"));
  const now = Math.floor(Date.now() / 1000);
  if (
    !hash || !/^[a-f0-9]{64}$/.test(hash) || !Number.isSafeInteger(authDate) || authDate > now + 60 ||
    now - authDate > INIT_DATA_MAX_AGE_SECONDS
  ) {
    throw new Error("Expired or invalid Telegram session");
  }
  params.delete("hash");
  // Telegram sorts keys alphabetically by code point, not by locale.
  const checkString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = await hmac("WebAppData", botToken);
  const expected = toHex(await hmac(secret, checkString));
  if (!timingSafeEqual(enc.encode(expected), enc.encode(hash))) throw new Error("Invalid Telegram signature");
  let user: Partial<TelegramUser>;
  try {
    user = JSON.parse(params.get("user") ?? "{}");
  } catch {
    throw new Error("Invalid Telegram user payload");
  }
  if (!Number.isSafeInteger(user.id) || user.id !== ownerId) throw new Error("Not authorized");
  return { id: user.id as number, username: user.username, first_name: user.first_name, auth_date: authDate };
}

// ---------------------------------------------------------------- sessions

export type SessionMethod = "telegram" | "password";

export interface SessionClaims {
  sub: number;
  /** Expiry, ms since epoch. */
  exp: number;
  /** Issued at, ms since epoch. */
  iat: number;
  /** Session version; bumping it in the database revokes every older session. */
  v: number;
  via: SessionMethod;
  /**
   * When the owner last proved they were present, ms since epoch. For a Telegram session this is the Mini App's
   * launch time (auth_date), NOT when the session was created: replaying day-old launch data must not look recent.
   * Missing in tokens issued by older versions (then `iat` is used).
   */
  at?: number;
  /** Unique id of this session, so signing out can revoke just this one. Missing in tokens from older versions. */
  jti?: string;
}

/** True when the owner opened the Mini App from Telegram within RECENT_SIGNIN_MS. */
export function isRecentSignIn(claims: SessionClaims, now = Date.now()): boolean {
  if (claims.via !== "telegram") return false;
  const at = claims.at ?? claims.iat;
  return at <= now + 60_000 && now - at < RECENT_SIGNIN_MS;
}

export async function createSession(
  userId: number,
  version: number,
  via: SessionMethod,
  secret = config.sessionSecret,
  authenticatedAt?: number,
) {
  const now = Date.now();
  const jti = toHex(crypto.getRandomValues(new Uint8Array(16)));
  const claims: SessionClaims = {
    sub: userId,
    exp: now + SESSION_LIFETIME_MS,
    iat: now,
    v: version,
    via,
    jti,
  };
  if (authenticatedAt !== undefined) claims.at = Math.min(authenticatedAt, now);
  const payload = base64UrlEncode(enc.encode(JSON.stringify(claims)));
  return `${payload}.${toHex(await hmac(secret, payload))}`;
}

/** Verifies signature, expiry and owner. The caller still has to compare `v` with the database. */
export async function verifySession(
  token: string,
  secret = config.sessionSecret,
  ownerId = config.ownerId,
): Promise<SessionClaims | null> {
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return null;
  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!/^[a-f0-9]{64}$/.test(signature)) return null;
  if (!safeEqualText(toHex(await hmac(secret, payload)), signature)) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as SessionClaims;
    const valid = claims.sub === ownerId && Number.isFinite(claims.exp) && claims.exp > Date.now() &&
      Number.isInteger(claims.v) && Number.isFinite(claims.iat) &&
      (claims.at === undefined || Number.isFinite(claims.at)) &&
      (claims.jti === undefined || (typeof claims.jti === "string" && /^[a-f0-9]{32}$/.test(claims.jti))) &&
      (claims.via === "telegram" || claims.via === "password");
    return valid ? claims : null;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------- passwords

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;

/** Returns an error message, or null when the password is acceptable. */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== "string") return "Password is required";
  if (password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters`;
  if (password.length > PASSWORD_MAX) return `Password must be at most ${PASSWORD_MAX} characters`;
  return null;
}

export async function hashPassword(password: string, saltValue?: string, iterations = PBKDF2_ITERATIONS) {
  if (password.length > PASSWORD_MAX) throw new Error("Password is too long");
  const salt = saltValue ? base64UrlDecode(saltValue) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    256,
  );
  return { salt: base64UrlEncode(salt), hash: base64UrlEncode(new Uint8Array(bits)), iterations };
}

export async function verifyPassword(
  password: string,
  salt: string,
  expectedHash: string,
  iterations: number,
) {
  try {
    const actual = await hashPassword(password, salt, iterations);
    return timingSafeEqual(base64UrlDecode(actual.hash), base64UrlDecode(expectedHash));
  } catch {
    return false;
  }
}

/** Work factor of hashes made before the iteration count was stored with each password. */
export const LEGACY_PBKDF2_ITERATIONS = 210_000;

/**
 * Checks a password against a stored hash. A missing iteration count means the original 210,000. Rows that an
 * older schema upgrade labelled with the current default although they were hashed at 210,000 are recognised too.
 * needsUpgrade tells the caller to re-hash with the current work factor after a successful sign-in.
 */
export async function verifyPasswordCompat(
  password: string,
  salt: string,
  hash: string,
  storedIterations: number | null,
): Promise<{ valid: boolean; needsUpgrade: boolean }> {
  const iterations = storedIterations ?? LEGACY_PBKDF2_ITERATIONS;
  if (await verifyPassword(password, salt, hash, iterations)) {
    return { valid: true, needsUpgrade: iterations < PBKDF2_ITERATIONS };
  }
  if (
    iterations === PBKDF2_ITERATIONS && await verifyPassword(password, salt, hash, LEGACY_PBKDF2_ITERATIONS)
  ) {
    return { valid: true, needsUpgrade: true };
  }
  return { valid: false, needsUpgrade: false };
}

/** Spends the same time as a failed check of a real account, so unknown usernames cannot be told apart by timing. */
export async function burnPasswordCheck(password: string) {
  const text = password.slice(0, PASSWORD_MAX);
  for (const iterations of [PBKDF2_ITERATIONS, LEGACY_PBKDF2_ITERATIONS]) {
    await hashPassword(text, "AAAAAAAAAAAAAAAAAAAAAA", iterations).catch(() => undefined);
  }
}

// ------------------------------------------------- share-token encryption

async function shareKey(secret: string) {
  const material = await crypto.subtle.digest("SHA-256", enc.encode(`share-token-key:${secret}`));
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** AES-GCM encrypts a share token so a database leak does not reveal working links. */
export async function encryptToken(plain: string, secret = config.shareSecret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await shareKey(secret), enc.encode(plain)),
  );
  return `${base64UrlEncode(iv)}.${base64UrlEncode(cipher)}`;
}

/** Keys tried when reading a stored link: the current one first, then SESSION_SECRET (links made before SHARE_SECRET existed). */
const defaultShareKeys = () => [...new Set([config.shareSecret, config.sessionSecret])];

export async function decryptToken(
  value: string | null | undefined,
  secrets: string | string[] = defaultShareKeys(),
): Promise<string | null> {
  if (!value) return null;
  const [iv, cipher] = value.split(".");
  for (const secret of Array.isArray(secrets) ? secrets : [secrets]) {
    try {
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: base64UrlDecode(iv) },
        await shareKey(secret),
        base64UrlDecode(cipher),
      );
      return new TextDecoder().decode(plain);
    } catch {
      // wrong key (or damaged value): try the next one
    }
  }
  return null;
}

/** URL-safe random token that fits Telegram's 64-character /start payload limit with the "share_" prefix. */
export const newShareToken = () => base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
