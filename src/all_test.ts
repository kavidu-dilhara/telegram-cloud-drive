// deno-lint-ignore-file no-inner-declarations
/** All backend and API-client tests in one file. Run with: deno task test */
import "./test_env.ts";
import assert from "node:assert/strict";
import {
  chunk,
  descendants,
  escapeLike,
  extensionOf,
  folderPath,
  formatSize,
  isUuid,
  parseIds,
  previewImageType,
  renameKeepingExtension,
  resolveClientIp,
  safeEqualText,
  sha256Hex,
  singleLine,
} from "./lib.ts";
import { toHex } from "./lib.ts";
import { Hono } from "hono";
import { AlbumReports, albumSummary, type AlbumTally, type SharedAlbum } from "./album.ts";
import { api, ApiError, fetchBlobUrl, setToken, setUnauthorizedHandler } from "../frontend/src/api.ts";
import { Bot } from "grammy";
import { webhookCallback } from "grammy";

// The hourly background cleanup starts with the first authenticated request. Let that one run happen now, against
// a database that does nothing, so it can never overlap (and disturb) a later test.
{
  const { maybeRunMaintenance } = await import("./maintenance.ts");
  const { db } = await import("./db.ts");
  // deno-lint-ignore no-explicit-any
  const client = db as any;
  const realFrom = client.from;
  const realRpc = client.rpc;
  const nothing = { data: [], count: 0, error: null };
  // deno-lint-ignore no-explicit-any
  const anything: any = new Proxy(() => anything, {
    get: (_target, name) =>
      name === "then" ? (done: (value: unknown) => unknown) => Promise.resolve(nothing).then(done) : anything,
    apply: () => anything,
  });
  client.from = () => anything;
  client.rpc = () => Promise.resolve(nothing);
  try {
    maybeRunMaintenance();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  } finally {
    client.from = realFrom;
    client.rpc = realRpc;
  }
}

// ======================================================================
// lib (was lib_test.ts)
// ======================================================================
{
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

  Deno.test("isUuid / parseIds validate and de-duplicate", () => {
    assert.ok(isUuid(id(1)));
    assert.equal(isUuid("nope"), false);
    assert.equal(isUuid(5), false);
    assert.deepEqual(parseIds([id(1), id(1), id(2)]), [id(1), id(2)]);
    assert.equal(parseIds([]), null);
    assert.equal(parseIds(["x"]), null);
    assert.equal(parseIds("nope"), null);
    assert.equal(parseIds(Array.from({ length: 201 }, (_, i) => id(i + 1))), null);
  });

  Deno.test("escapeLike makes % _ and backslash literal", () => {
    assert.equal(escapeLike("50%_off\\"), "50\\%\\_off\\\\");
  });

  Deno.test("chunk splits evenly", () => {
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(chunk([], 3), []);
  });

  Deno.test("descendants never includes unrelated folders and handles chains", () => {
    const rows = [
      { id: "a", parent_id: null },
      { id: "b", parent_id: "a" },
      { id: "c", parent_id: "b" },
      { id: "x", parent_id: null },
    ];
    assert.deepEqual([...descendants("a", rows)].sort(), ["a", "b", "c"]);
    assert.deepEqual([...descendants("x", rows)], ["x"]);
  });

  Deno.test("folderPath builds readable paths and survives cycles", () => {
    const folders = [
      { id: "a", parent_id: null, name: "Projects" },
      { id: "b", parent_id: "a", name: "2026" },
      { id: "c", parent_id: "d", name: "Loop1" },
      { id: "d", parent_id: "c", name: "Loop2" },
    ];
    assert.equal(folderPath("b", folders), "/Projects/2026");
    assert.equal(folderPath(null, folders), "/");
    assert.equal(folderPath("missing", folders), "/");
    assert.ok(folderPath("c", folders).startsWith("/"));
  });

  Deno.test("extensionOf", () => {
    assert.equal(extensionOf("report.PDF"), "pdf");
    assert.equal(extensionOf("archive.tar.gz"), "gz");
    assert.equal(extensionOf("noext"), null);
    assert.equal(extensionOf(".hidden"), null);
    assert.equal(extensionOf("trailing."), null);
  });

  Deno.test("rename changes only the name and always keeps the extension", () => {
    assert.equal(renameKeepingExtension("report.pdf", "Summary"), "Summary.pdf");
    assert.equal(renameKeepingExtension("report.pdf", "Summary.pdf"), "Summary.pdf");
    assert.equal(renameKeepingExtension("report.PDF", "Summary.pdf"), "Summary.PDF");
    assert.equal(renameKeepingExtension("report.pdf", "Summary.exe"), "Summary.exe.pdf");
    assert.equal(renameKeepingExtension("voice_12", "note"), "note");
    assert.equal(renameKeepingExtension("a.txt", "  a/b\\c  "), "a b c.txt");
    assert.equal(renameKeepingExtension("a.txt", "   "), null);
    assert.equal(renameKeepingExtension("a.txt", ".txt"), null);
    assert.equal(renameKeepingExtension("a.txt", "x".repeat(300)), null);
  });

  Deno.test("formatSize and singleLine", () => {
    assert.equal(formatSize(0), "0 B");
    assert.equal(formatSize(512), "512 B");
    assert.equal(formatSize(1536), "2 KB");
    assert.equal(formatSize(5 * 1048576), "5.00 MB");
    assert.equal(formatSize(3 * 1073741824), "3.00 GB");
    assert.equal(formatSize(NaN), "0 B");
    assert.equal(singleLine("a\nb\r\nc"), "a b c");
    assert.equal(singleLine(5), "");
    assert.equal(singleLine("x".repeat(500), 10).length, 10);
  });

  Deno.test("sha256Hex and safeEqualText", async () => {
    assert.equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert.ok(safeEqualText("same", "same"));
    assert.equal(safeEqualText("same", "diff"), false);
    assert.equal(safeEqualText("short", "longer-text"), false);
  });

  Deno.test("resolveClientIp: forwarding headers are ignored unless a trusted header is configured", () => {
    const headers = new Headers({ "CF-Connecting-IP": "6.6.6.6", "X-Forwarded-For": "7.7.7.7, 8.8.8.8" });
    assert.equal(resolveClientIp(headers, "10.0.0.5"), "10.0.0.5");
    assert.equal(resolveClientIp(headers, undefined), "unknown");
  });

  Deno.test("resolveClientIp: cf-connecting-ip is used only when configured and valid", () => {
    const options = { header: "cf-connecting-ip" as const };
    assert.equal(
      resolveClientIp(new Headers({ "CF-Connecting-IP": "203.0.113.7" }), "10.0.0.5", options),
      "203.0.113.7",
    );
    assert.equal(
      resolveClientIp(new Headers({ "CF-Connecting-IP": "not-an-ip" }), "10.0.0.5", options),
      "10.0.0.5",
    );
    assert.equal(resolveClientIp(new Headers(), "10.0.0.5", options), "10.0.0.5");
  });

  Deno.test("resolveClientIp: x-forwarded-for is read from the right, not the forgeable left", () => {
    const options = { header: "x-forwarded-for" as const };
    const forged = new Headers({ "X-Forwarded-For": "1.2.3.4, 198.51.100.20" });
    assert.equal(resolveClientIp(forged, "10.0.0.5", options), "198.51.100.20");
    assert.equal(resolveClientIp(forged, "10.0.0.5", { ...options, hops: 2 }), "1.2.3.4");
    assert.equal(resolveClientIp(forged, "10.0.0.5", { ...options, hops: 3 }), "10.0.0.5");
    assert.equal(
      resolveClientIp(new Headers({ "X-Forwarded-For": "2001:db8::1" }), "10.0.0.5", options),
      "2001:db8::1",
    );
    assert.equal(
      resolveClientIp(new Headers({ "X-Forwarded-For": "junk" }), "10.0.0.5", options),
      "10.0.0.5",
    );
  });

  Deno.test("previewImageType: only safe raster images are previewable, never SVG", () => {
    assert.equal(previewImageType("image/png"), "image/png");
    assert.equal(previewImageType("IMAGE/JPEG"), "image/jpeg");
    assert.equal(previewImageType("image/jpg"), "image/jpeg");
    assert.equal(previewImageType("image/webp; charset=binary"), "image/webp");
    assert.equal(previewImageType("image/gif"), "image/gif");
    for (
      const unsafe of [
        "image/svg+xml",
        "IMAGE/SVG+XML",
        "image/svg+xml;charset=utf-8",
        "image/x-icon",
        "text/html",
        "",
        null,
        undefined,
      ]
    ) {
      assert.equal(previewImageType(unsafe), null);
    }
  });
}

// ======================================================================
// security (was security_test.ts)
// ======================================================================
{
  const security = await import("./security.ts");
  const enc = new TextEncoder();
  const BOT_TOKEN = "123456:unit-test-token";

  async function hmac(key: BufferSource, message: string) {
    const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ]);
    return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message)));
  }

  /** Builds initData signed exactly the way Telegram does. */
  async function signedInitData(
    user: Record<string, unknown>,
    authDate = Math.floor(Date.now() / 1000),
    token = BOT_TOKEN,
  ) {
    const params = new URLSearchParams({
      auth_date: String(authDate),
      query_id: "AAH",
      signature: "sig",
      user: JSON.stringify(user),
    });
    const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`)
      .join(
        "\n",
      );
    const secret = await hmac(enc.encode("WebAppData"), token);
    params.set("hash", toHex(await hmac(secret as BufferSource, check)));
    return params.toString();
  }

  Deno.test("initData: valid signature for the owner is accepted", async () => {
    const user = await security.verifyMiniAppInitData(await signedInitData({ id: 42, first_name: "Owner" }));
    assert.equal(user.id, 42);
  });

  Deno.test("initData: wrong user, tampering, wrong bot, expiry and junk are rejected", async () => {
    await assert.rejects(security.verifyMiniAppInitData(await signedInitData({ id: 7 })), /Not authorized/);
    const good = await signedInitData({ id: 42 });
    await assert.rejects(security.verifyMiniAppInitData(good.replace("AAH", "AAX")), /signature/);
    await assert.rejects(
      security.verifyMiniAppInitData(await signedInitData({ id: 42 }, undefined, "999:other-token")),
      /signature/,
    );
    // A Mini App left open for a few hours still carries its original launch data: accepted.
    assert.equal(
      (await security.verifyMiniAppInitData(
        await signedInitData({ id: 42 }, Math.floor(Date.now() / 1000) - 7200),
      )).id,
      42,
    );
    await assert.rejects(
      security.verifyMiniAppInitData(
        await signedInitData({ id: 42 }, Math.floor(Date.now() / 1000) - 3 * 86400),
      ),
      /Expired/,
    );
    await assert.rejects(security.verifyMiniAppInitData(""), /Invalid/);
    await assert.rejects(security.verifyMiniAppInitData("x".repeat(9000)), /Invalid/);
  });

  Deno.test("sessions: created sessions verify and carry version + method", async () => {
    const claims = await security.verifySession(await security.createSession(42, 3, "password"));
    assert.ok(claims);
    assert.equal(claims.v, 3);
    assert.equal(claims.via, "password");
    assert.equal(claims.sub, 42);
  });

  Deno.test("sessions: tampered, forged, foreign-secret, other-user and malformed tokens are rejected", async () => {
    const token = await security.createSession(42, 1, "telegram");
    const [payload, signature] = token.split(".");
    assert.equal(
      await security.verifySession(`${payload}.${signature[0] === "0" ? "1" : "0"}${signature.slice(1)}`),
      null,
    );
    const forged = btoa(
      JSON.stringify({ sub: 42, exp: Date.now() + 60_000, iat: Date.now(), v: 1, via: "telegram" }),
    );
    assert.equal(await security.verifySession(`${forged}.${signature}`), null);
    const otherSecret = await security.createSession(
      42,
      1,
      "telegram",
      "another-secret-another-secret-another-secret",
    );
    assert.equal(await security.verifySession(otherSecret), null);
    assert.equal(
      await security.verifySession(await security.createSession(7, 1, "telegram")),
      null,
      "other users are rejected",
    );
    for (const junk of ["", "not-a-session", "a.b", "."]) {
      assert.equal(await security.verifySession(junk), null);
    }
  });

  Deno.test("passwords: hash round-trip, wrong password, iteration count is honoured", async () => {
    const { hash, salt, iterations } = await security.hashPassword("correct horse battery", undefined, 1000);
    assert.equal(iterations, 1000);
    assert.ok(await security.verifyPassword("correct horse battery", salt, hash, 1000));
    assert.equal(await security.verifyPassword("wrong password!!", salt, hash, 1000), false);
    assert.equal(
      await security.verifyPassword("correct horse battery", salt, hash, 2000),
      false,
      "different work factor, different hash",
    );
    assert.equal(await security.verifyPassword("x", "###", "###", 1000), false, "garbage input never throws");
  });

  Deno.test("passwords: policy messages", () => {
    assert.match(security.passwordProblem("short") ?? "", /at least 12/);
    assert.match(security.passwordProblem("x".repeat(300)) ?? "", /at most/);
    assert.equal(security.passwordProblem("twelve chars!"), null);
    assert.ok(security.passwordProblem(undefined));
    assert.equal(security.PBKDF2_ITERATIONS >= 600_000, true);
  });

  Deno.test("share tokens: encrypted at rest, decrypt back, wrong key fails, tokens fit Telegram's limit", async () => {
    const token = security.newShareToken();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(`share_${token}`.length <= 64);
    const sealed = await security.encryptToken(token);
    assert.ok(!sealed.includes(token));
    assert.equal(await security.decryptToken(sealed), token);
    assert.notEqual(await security.encryptToken(token), sealed, "random IV each time");
    assert.equal(await security.decryptToken(sealed, "different-secret-different-secret-different"), null);
    assert.equal(await security.decryptToken("garbage"), null);
    assert.equal(await security.decryptToken(null), null);
  });
}

// ======================================================================
// session (was session_test.ts)
// ======================================================================
{
  const { db } = await import("./db.ts");
  const { config } = await import("./config.ts");
  const { createSession } = await import("./security.ts");
  const { requireAuth } = await import("./routes/auth.ts");
  const { handleError } = await import("./http.ts");

  // deno-lint-ignore no-explicit-any
  const client = db as any;
  const realFrom = client.from;
  const realRpc = client.rpc;
  const restore = () => {
    client.from = realFrom;
    client.rpc = realRpc;
  };

  const app = new Hono();
  app.onError(handleError);
  app.use("*", requireAuth);
  app.get("/ok", (c) => c.text("ok"));
  const call = (token: string) => app.request("/ok", { headers: { Authorization: `Bearer ${token}` } });

  /** What the database answers for a session check. */
  const checkAnswer = (version: number, revoked = false) => () =>
    Promise.resolve({ data: [{ o_version: version, o_revoked: revoked }], error: null });

  Deno.test("sessions: every new session has its own id", async () => {
    const [a, b] = [
      await createSession(config.ownerId, 1, "password"),
      await createSession(config.ownerId, 1, "password"),
    ];
    const idOf = (token: string) =>
      JSON.parse(atob(token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/"))).jti as string;
    assert.match(idOf(a), /^[a-f0-9]{32}$/);
    assert.notEqual(idOf(a), idOf(b));
  });

  Deno.test("sessions: a version bump or a sign-out takes effect on the very next request", async () => {
    try {
      const token = await createSession(config.ownerId, 1, "password");
      client.rpc = checkAnswer(1);
      assert.equal((await call(token)).status, 200);
      client.rpc = checkAnswer(2); // another instance signed out everywhere
      assert.equal((await call(token)).status, 401);
      client.rpc = checkAnswer(1, true); // this one session was signed out
      assert.equal((await call(token)).status, 401);
      client.rpc = checkAnswer(1);
      assert.equal((await call(token)).status, 200); // other sessions are untouched
    } finally {
      restore();
    }
  });

  Deno.test("sessions: the check sends the session id, and an unreadable answer is 503 (never 'accepted')", async () => {
    try {
      const token = await createSession(config.ownerId, 1, "password");
      const calls: Array<{ name: string; args: unknown }> = [];
      client.rpc = (name: string, args: unknown) => (calls.push({ name, args }), checkAnswer(1)());
      await call(token);
      assert.equal(calls[0].name, "check_session");
      assert.equal((calls[0].args as { p_telegram_id: number }).p_telegram_id, config.ownerId);
      assert.match((calls[0].args as { p_jti: string }).p_jti, /^[a-f0-9]{32}$/);

      for (
        const broken of [{ data: null, error: { message: "boom" } }, { data: [], error: null }, {
          data: [{ o_revoked: false }],
          error: null,
        }]
      ) {
        client.rpc = () => Promise.resolve(broken);
        const response = await call(token);
        assert.equal(response.status, 503);
        assert.equal(response.headers.get("Retry-After"), "5");
      }
    } finally {
      restore();
    }
  });

  /** A token made by an older version: no session id, so only the version can be checked. */
  async function legacyToken(version: number) {
    const enc = new TextEncoder();
    const now = Date.now();
    const payload = btoa(
      JSON.stringify({ sub: config.ownerId, exp: now + 3_600_000, iat: now, v: version, via: "password" }),
    )
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(config.sessionSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(payload)))].map((
      b,
    ) => b.toString(16).padStart(2, "0")).join("");
    return `${payload}.${signature}`;
  }

  Deno.test("sessions: tokens from before session ids still work and still honour the version", async () => {
    try {
      const answer = (data: unknown, error: unknown = null) => () => ({
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data, error }) }) }),
      });
      const token = await legacyToken(1);
      client.from = answer({ session_version: 1 });
      assert.equal((await call(token)).status, 200);
      client.from = answer({ session_version: 2 });
      assert.equal((await call(token)).status, 401);
      client.from = answer(null, { message: "boom" });
      assert.equal((await call(token)).status, 503);
    } finally {
      restore();
    }
  });
}

// ======================================================================
// http (was http_test.ts)
// ======================================================================
{
  const { API_BODY_LIMIT, apiBodyLimit, AUTH_BODY_LIMIT, jsonBody } = await import("./http.ts");

  const app = new Hono();
  app.use("/api/*", apiBodyLimit);
  app.post("/api/echo", async (c) => c.json({ body: await jsonBody(c) }));
  app.post("/api/auth/echo", async (c) => c.json({ body: await jsonBody(c) }));

  const post = (path: string, body: BodyInit, headers: Record<string, string> = {}) =>
    app.request(path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });

  const json = (size: number) => JSON.stringify({ pad: "x".repeat(size) });

  Deno.test("body limit: normal bodies pass on both route groups", async () => {
    assert.equal((await post("/api/echo", json(100))).status, 200);
    assert.equal((await post("/api/auth/echo", json(100))).status, 200);
  });

  Deno.test("body limit: oversized bodies get a JSON 413 before parsing", async () => {
    const response = await post("/api/echo", json(API_BODY_LIMIT + 1));
    assert.equal(response.status, 413);
    assert.equal((await response.json() as { error: string }).error, "Request body is too large");
  });

  Deno.test("body limit: sign-in routes use the stricter limit", async () => {
    assert.equal(AUTH_BODY_LIMIT < API_BODY_LIMIT, true);
    assert.equal((await post("/api/auth/echo", json(AUTH_BODY_LIMIT + 1))).status, 413);
    assert.equal((await post("/api/echo", json(AUTH_BODY_LIMIT + 1))).status, 200);
  });

  Deno.test("body limit: a lying small Content-Length is not trusted for chunked bodies", async () => {
    const chunk = new TextEncoder().encode("x".repeat(1024));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 40; index++) controller.enqueue(chunk);
        controller.close();
      },
    });
    const response = await app.request("/api/auth/echo", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Transfer-Encoding": "chunked" },
      body: stream,
      // @ts-ignore required by the Fetch spec for streamed request bodies
      duplex: "half",
    });
    assert.equal(response.status, 413);
  });

  Deno.test("body limit: declared Content-Length over the limit is refused", async () => {
    const response = await post("/api/auth/echo", "{}", { "Content-Length": String(AUTH_BODY_LIMIT + 1) });
    assert.equal(response.status, 413);
  });
}

// ======================================================================
// rateLimit (was rateLimit_test.ts)
// ======================================================================
{
  const { db } = await import("./db.ts");
  const { reserveAttempt, ThrottleUnavailableError } = await import("./rateLimit.ts");
  const { publicAuth } = await import("./routes/auth.ts");
  const { handleError } = await import("./http.ts");
  const { hashPassword, LEGACY_PBKDF2_ITERATIONS, PBKDF2_ITERATIONS, verifyPasswordCompat } = await import(
    "./security.ts"
  );

  // deno-lint-ignore no-explicit-any
  const client = db as any;
  const realFrom = client.from;
  const realRpc = client.rpc;
  const restore = () => {
    client.from = realFrom;
    client.rpc = realRpc;
  };

  // ------------------------------------------------------------ reserveAttempt

  Deno.test("reserveAttempt: sends every key with its limit and returns the database's answer", async () => {
    try {
      const calls: unknown[] = [];
      client.rpc = (name: string, args: unknown) => {
        calls.push({ name, args });
        return Promise.resolve({ data: calls.length === 1, error: null });
      };
      const rules = [{ key: "user:a", max: 10 }, { key: "ip:1.2.3.4", max: 10 }, { key: "global", max: 40 }];
      assert.equal(await reserveAttempt(rules), true);
      assert.equal(await reserveAttempt(rules), false);
      assert.deepEqual(calls[0] as { name: string; args: unknown }, {
        name: "reserve_login_attempt",
        args: { p_keys: ["user:a", "ip:1.2.3.4", "global"], p_maxes: [10, 10, 40], p_window_seconds: 900 },
      });
    } finally {
      restore();
    }
  });

  Deno.test("reserveAttempt: fails closed on errors, odd answers and exceptions", async () => {
    try {
      for (
        const answer of [
          () => Promise.resolve({ data: null, error: { message: "function missing" } }),
          () => Promise.resolve({ data: null, error: null }),
          () => Promise.resolve({ data: "yes", error: null }),
          () => Promise.reject(new Error("network")),
        ]
      ) {
        client.rpc = answer;
        await assert.rejects(() => reserveAttempt([{ key: "x", max: 1 }]), ThrottleUnavailableError);
      }
    } finally {
      restore();
    }
  });

  // ------------------------------------------------------------- login route

  const OWNER = { password_enabled: true, login_username: "owner" };
  const json = (body: unknown) => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  /** A database where `row` is the owner, with a counter that really is atomic, like the SQL function. */
  function loginDb(row: unknown, options: { max?: number } = {}) {
    const log = { reserved: 0, refunds: [] as unknown[], cleared: [] as unknown[], updates: [] as unknown[] };
    client.rpc = (name: string, args: { p_keys?: string[] }) => {
      if (name === "reserve_login_attempt") {
        log.reserved++;
        return Promise.resolve({ data: log.reserved <= (options.max ?? 10), error: null });
      }
      if (name === "refund_login_attempt") log.refunds.push(args.p_keys);
      return Promise.resolve({ data: null, error: null });
    };
    client.from = (table: string) => {
      if (table === "users") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({ data: { ...(row as object), session_version: 1 }, error: null }),
            }),
          }),
          update: (values: unknown) => ({
            eq: () => (log.updates.push(values), Promise.resolve({ error: null })),
          }),
        };
      }
      if (table === "login_attempts") {
        return {
          delete: () => ({
            in: (_c: string, keys: unknown) => (log.cleared.push(keys), Promise.resolve({ error: null })),
          }),
        };
      }
      return { insert: () => Promise.resolve({ error: null }) };
    };
    const app = new Hono();
    app.onError(handleError);
    app.route("/api/auth", publicAuth);
    return { app, log };
  }
  const login = (app: Hono, password: string) =>
    app.request("/api/auth/password/login", json({ username: "owner", password }));

  Deno.test("login: 503 when the counters are unavailable, 429 when a limit is reached", async () => {
    try {
      const { app } = loginDb(OWNER);
      client.rpc = () => Promise.resolve({ data: null, error: { message: "boom" } });
      const down = await login(app, "whatever-password");
      assert.equal(down.status, 503);
      assert.equal(down.headers.get("Retry-After"), "60");
      client.rpc = () => Promise.resolve({ data: false, error: null });
      const limited = await login(app, "whatever-password");
      assert.equal(limited.status, 429);
      assert.equal(limited.headers.get("Retry-After"), "900");
    } finally {
      restore();
    }
  });

  Deno.test("login: parallel wrong guesses cannot exceed the limit (the burst bug)", async () => {
    try {
      const { app, log } = loginDb(
        { ...OWNER, password_hash: "x", password_salt: "AAAAAAAAAAAAAAAAAAAAAA" },
        {
          max: 10,
        },
      );
      const results = await Promise.all(Array.from({ length: 24 }, () => login(app, "wrong-password-guess")));
      const statuses = results.map((response) => response.status);
      assert.equal(
        statuses.filter((status) => status === 401).length,
        10,
        "only 10 guesses reach the password check",
      );
      assert.equal(statuses.filter((status) => status === 429).length, 14);
      assert.equal(log.reserved, 24); // every attempt was counted before any password work
    } finally {
      restore();
    }
  });

  Deno.test("login: success clears the user and ip counters and refunds the shared one; a wrong password adds no extra count", async () => {
    try {
      const stored = await hashPassword("correct horse battery");
      const { app, log } = loginDb({
        ...OWNER,
        password_hash: stored.hash,
        password_salt: stored.salt,
        password_iterations: stored.iterations,
      });
      assert.equal((await login(app, "not the password")).status, 401);
      assert.equal(log.reserved, 1);
      assert.deepEqual(log.refunds, []);
      const ok = await login(app, "correct horse battery");
      assert.equal(ok.status, 200);
      assert.ok((await ok.json() as { token: string }).token);
      assert.deepEqual(log.cleared[0], ["user:owner", "ip:unknown"]);
      assert.deepEqual(log.refunds, [["global"]]);
      assert.deepEqual(log.updates, []); // already at the current work factor: no re-hash
    } finally {
      restore();
    }
  });

  Deno.test("login: an outage while reading the account refunds the reserved attempt and answers 503", async () => {
    try {
      const { app, log } = loginDb(OWNER);
      const original = client.from;
      client.from = (table: string) =>
        table === "users"
          ? {
            select: () => ({
              eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: "boom" } }) }),
            }),
          }
          : original(table);
      assert.equal((await login(app, "whatever-password")).status, 503);
      assert.deepEqual(log.refunds, [["user:owner", "ip:unknown", "global"]]);
    } finally {
      restore();
    }
  });

  // ------------------------------------------------- old password hashes (upgrade)

  Deno.test("old hashes: NULL iterations means 210,000 and the hash is upgraded after sign-in", async () => {
    try {
      const legacy = await hashPassword("correct horse battery", undefined, LEGACY_PBKDF2_ITERATIONS);
      const { app, log } = loginDb({
        ...OWNER,
        password_hash: legacy.hash,
        password_salt: legacy.salt,
        password_iterations: null, // a row from before the column existed
      });
      assert.equal((await login(app, "wrong password here")).status, 401);
      assert.equal((await login(app, "correct horse battery")).status, 200);
      assert.equal(log.updates.length, 1);
      assert.equal(
        (log.updates[0] as { password_iterations: number }).password_iterations,
        PBKDF2_ITERATIONS,
      );
    } finally {
      restore();
    }
  });

  Deno.test("old hashes: rows wrongly labelled 600,000 by the earlier schema upgrade still sign in and are fixed", async () => {
    try {
      const legacy = await hashPassword("correct horse battery", undefined, LEGACY_PBKDF2_ITERATIONS);
      const { app, log } = loginDb({
        ...OWNER,
        password_hash: legacy.hash,
        password_salt: legacy.salt,
        password_iterations: PBKDF2_ITERATIONS, // the label the old migration gave every row
      });
      assert.equal((await login(app, "correct horse battery")).status, 200);
      assert.equal(log.updates.length, 1);
    } finally {
      restore();
    }
  });

  Deno.test("verifyPasswordCompat: every combination", async () => {
    const modern = await hashPassword("pw-correct-horse");
    const legacy = await hashPassword("pw-correct-horse", undefined, LEGACY_PBKDF2_ITERATIONS);
    assert.deepEqual(
      await verifyPasswordCompat("pw-correct-horse", modern.salt, modern.hash, PBKDF2_ITERATIONS),
      { valid: true, needsUpgrade: false },
    );
    assert.deepEqual(await verifyPasswordCompat("pw-correct-horse", legacy.salt, legacy.hash, null), {
      valid: true,
      needsUpgrade: true,
    });
    assert.deepEqual(
      await verifyPasswordCompat("pw-correct-horse", legacy.salt, legacy.hash, LEGACY_PBKDF2_ITERATIONS),
      { valid: true, needsUpgrade: true },
    );
    assert.deepEqual(
      await verifyPasswordCompat("pw-correct-horse", legacy.salt, legacy.hash, PBKDF2_ITERATIONS),
      { valid: true, needsUpgrade: true },
    );
    assert.deepEqual(await verifyPasswordCompat("wrong", modern.salt, modern.hash, PBKDF2_ITERATIONS), {
      valid: false,
      needsUpgrade: false,
    });
    assert.deepEqual(await verifyPasswordCompat("wrong", legacy.salt, legacy.hash, null), {
      valid: false,
      needsUpgrade: false,
    });
  });
}

// ======================================================================
// album (was album_test.ts)
// ======================================================================
{
  const zero = { saved: 0, duplicate: 0, trashed: 0, empty: 0, failed: 0 };

  Deno.test("albumSummary: failures are always spelled out", () => {
    assert.equal(albumSummary({ ...zero, saved: 3 }), "✅ Album: 3 saved.");
    assert.equal(
      albumSummary({ ...zero, saved: 2, failed: 1 }),
      "⚠️ Album: 2 saved, 1 failed.\nSend the failed files again - nothing else was lost.",
    );
    assert.equal(
      albumSummary({ ...zero, saved: 1, duplicate: 1, trashed: 1 }),
      "✅ Album: 1 saved, 1 already in your Cloud Drive, 1 already in your Trash.",
    );
    assert.equal(albumSummary({ ...zero, failed: 3 }).startsWith("⚠️ Album: 3 failed."), true);
  });

  Deno.test("AlbumReports: one status message for the whole album, final text shows every file", async () => {
    const reports = new AlbumReports();
    let opened = 0;
    const edits: string[] = [];
    const open = () => (opened++, Promise.resolve(77));
    const edit = (id: number, text: string) => (assert.equal(id, 77), edits.push(text), Promise.resolve());

    const a = reports.join("chat:album", open, edit);
    const b = reports.join("chat:album", open, edit);
    const c = reports.join("chat:album", open, edit);
    assert.equal(opened, 1);

    // files finish in any order; one of them fails
    await Promise.all([b.record("failed"), a.record("saved"), c.record("saved")]);
    assert.equal(
      edits.at(-1),
      "⚠️ Album: 2 saved, 1 failed.\nSend the failed files again - nothing else was lost.",
    );
    // edits run one after another, and one that would repeat the text on screen is skipped
    assert.ok(edits.length >= 1 && edits.length <= 3);
    assert.equal(new Set(edits).size, edits.length);
  });

  Deno.test("AlbumReports: the first file's success is not reported as the whole album", async () => {
    const reports = new AlbumReports();
    const edits: string[] = [];
    const edit = (_id: number, text: string) => (edits.push(text), Promise.resolve());
    const first = reports.join("k", () => Promise.resolve(1), edit);
    const second = reports.join("k", () => Promise.resolve(1), edit);
    await first.record("saved");
    assert.equal(edits.at(-1), "✅ Album: 1 saved."); // so far
    await second.record("failed");
    assert.match(edits.at(-1)!, /1 saved, 1 failed/); // the later failure is reported, not swallowed
  });

  Deno.test("AlbumReports: separate albums and expired albums do not mix", async () => {
    let now = 0;
    const reports = new AlbumReports(1000, () => now);
    const edits: string[] = [];
    const edit = (_id: number, text: string) => (edits.push(text), Promise.resolve());
    let opened = 0;
    const open = () => (opened++, Promise.resolve(opened));
    await reports.join("one", open, edit).record("saved");
    await reports.join("two", open, edit).record("failed");
    assert.equal(opened, 2);
    now = 5000; // album "one" expired
    await reports.join("one", open, edit).record("saved");
    assert.equal(opened, 3);
    assert.equal(edits.at(-1), "✅ Album: 1 saved.");
  });

  Deno.test("AlbumReports: a status message that cannot be opened or edited never throws", async () => {
    const reports = new AlbumReports();
    await reports.join("x", () => Promise.reject(new Error("telegram down")), () => Promise.resolve()).record(
      "saved",
    );
    await reports.join("y", () => Promise.resolve(5), () => Promise.reject(new Error("message not modified")))
      .record("saved");
  });
}

// ======================================================================
// frontend api (was frontend_api_test.ts)
// ======================================================================
{
  type Call = { path: string; auth: string | null };

  /** Replaces fetch: `answer(path, auth)` decides each response. */
  function mockFetch(answer: (path: string, auth: string | null) => Response | Promise<Response>) {
    const calls: Call[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      calls.push({ path, auth });
      return Promise.resolve(answer(path, auth));
    }) as typeof fetch;
    return { calls, restore: () => (globalThis.fetch = real) };
  }
  const ok = (body: unknown) => new Response(JSON.stringify(body));
  const unauthorized = () => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });

  Deno.test("expired session: one silent renewal for many failing requests, each is repeated once", async () => {
    let renewals = 0;
    setToken("old");
    setUnauthorizedHandler(async () => {
      renewals++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      setToken("renewed");
      return true;
    });
    const mock = mockFetch((_path, auth) => (auth === "Bearer renewed" ? ok({ ok: true }) : unauthorized()));
    try {
      const results = await Promise.all([api("/api/a"), api("/api/b"), api("/api/c")]);
      assert.deepEqual(results, [{ ok: true }, { ok: true }, { ok: true }]);
      assert.equal(renewals, 1);
      assert.equal(mock.calls.length, 6); // 3 failed + 3 repeated
      assert.equal(mock.calls.filter((call) => call.auth === "Bearer renewed").length, 3);
    } finally {
      mock.restore();
      setUnauthorizedHandler(null);
      setToken(null);
    }
  });

  Deno.test("expired session: when renewal fails the request fails with 401 and is not repeated", async () => {
    setUnauthorizedHandler(() => Promise.resolve(false));
    const mock = mockFetch(() => unauthorized());
    try {
      await assert.rejects(
        () => api("/api/files"),
        (error: ApiError) => error.status === 401 && error.message === "Unauthorized",
      );
      assert.equal(mock.calls.length, 1);
    } finally {
      mock.restore();
      setUnauthorizedHandler(null);
    }
  });

  Deno.test("expired session: still 401 after renewal gives up (no loop)", async () => {
    let renewals = 0;
    setUnauthorizedHandler(() => (renewals++, Promise.resolve(true)));
    const mock = mockFetch(() => unauthorized());
    try {
      await assert.rejects(() => api("/api/files"), (error: ApiError) => error.status === 401);
      assert.equal(renewals, 1);
      assert.equal(mock.calls.length, 2);
    } finally {
      mock.restore();
      setUnauthorizedHandler(null);
    }
  });

  Deno.test("quiet401 requests and public sign-in routes never start a renewal", async () => {
    let renewals = 0;
    setUnauthorizedHandler(() => (renewals++, Promise.resolve(true)));
    const mock = mockFetch(() => unauthorized());
    try {
      await assert.rejects(
        () => api("/api/settings", { quiet401: true }),
        (error: ApiError) => error.status === 401,
      );
      await assert.rejects(
        () => api("/api/auth/telegram", { method: "POST", json: {} }),
        (error: ApiError) => error.status === 401,
      );
      await assert.rejects(
        () => api("/api/auth/password/login", { method: "POST", json: {} }),
        (error: ApiError) => error.status === 401,
      );
      assert.equal(renewals, 0);
      assert.equal(mock.calls.length, 3);
    } finally {
      mock.restore();
      setUnauthorizedHandler(null);
    }
  });

  Deno.test("renewal can run again for a later expiry, and network errors keep their message", async () => {
    let renewals = 0;
    setUnauthorizedHandler(() => (renewals++, setToken(`t${renewals}`), Promise.resolve(true)));
    let expired = true;
    const mock = mockFetch((
      _path,
      auth,
    ) => (expired && auth !== "Bearer t2" && auth !== "Bearer t1" ? unauthorized() : ok({ ok: 1 })));
    try {
      await api("/api/x");
      assert.equal(renewals, 1);
      setToken(null);
      await api("/api/y");
      assert.equal(renewals, 2);
      expired = false;
      mock.restore();
      globalThis.fetch = (() => Promise.reject(new TypeError("offline"))) as typeof fetch;
      await assert.rejects(
        () => api("/api/z"),
        (error: ApiError) => error.status === 0 && /Cannot reach the server/.test(error.message),
      );
    } finally {
      mock.restore();
      setUnauthorizedHandler(null);
      setToken(null);
    }
  });

  Deno.test("image previews renew an expired session too, then load", async () => {
    setToken("old");
    setUnauthorizedHandler(() => (setToken("renewed"), Promise.resolve(true)));
    const mock = mockFetch((_path, auth) =>
      auth === "Bearer renewed"
        ? new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/png" } })
        : unauthorized()
    );
    try {
      const url = await fetchBlobUrl("/api/files/1/preview");
      assert.match(url, /^blob:/);
      assert.equal(mock.calls.length, 2);
      URL.revokeObjectURL(url);
    } finally {
      mock.restore();
      setUnauthorizedHandler(null);
      setToken(null);
    }
  });

  Deno.test("image previews that cannot be loaded say so (and do not loop)", async () => {
    setUnauthorizedHandler(() => Promise.resolve(false));
    const mock = mockFetch(() => unauthorized());
    try {
      await assert.rejects(
        () => fetchBlobUrl("/api/files/1/preview"),
        (error: ApiError) => error.status === 401 && error.message === "Preview unavailable",
      );
      assert.equal(mock.calls.length, 1);
    } finally {
      mock.restore();
      setUnauthorizedHandler(null);
    }
  });
}

// ======================================================================
// batch5 (was batch5_test.ts)
// ======================================================================
{
  Deno.env.set("BOT_USERNAME", "ci_bot");
  const { db, folderExists, getSetting } = await import("./db.ts");
  const { contentDisposition, intParam, renameKeepingExtension, suffixOf, WEBHOOK_TIMEOUT_MS } = await import(
    "./lib.ts"
  );
  const { fileRoutes } = await import("./routes/files.ts");
  const { publicAuth, privateAuth } = await import("./routes/auth.ts");
  const { handleError, ServiceUnavailableError } = await import("./http.ts");
  const { config } = await import("./config.ts");
  const { storeIncoming } = await import("./storage.ts");
  const { bot } = await import("./telegram.ts");
  const { answerFailure, editQuietly, isNotModified } = await import("./botErrors.ts");

  // deno-lint-ignore no-explicit-any
  const client = db as any;
  const realFrom = client.from;
  const realRpc = client.rpc;
  const restore = () => {
    client.from = realFrom;
    client.rpc = realRpc;
  };
  const FILE = "22222222-2222-4222-8222-2222222222f1";

  // ---------------------------------------------------------------- 1. file names in headers

  Deno.test("contentDisposition: every file name makes a valid header", () => {
    const names = [
      "ස.png",
      "résumé.pdf",
      "日本語.txt",
      "emoji 😀.png",
      'quote".png',
      "back\\slash.png",
      "100%.png",
      "it's (1)*.png",
      "line\r\nbreak.png",
      "a".repeat(255) + ".png",
      "\ud800broken.png",
      "   ",
      "",
    ];
    for (const name of names) {
      const header = contentDisposition(name);
      new Response("x", { headers: { "Content-Disposition": header } }); // must not throw
      // a plain-ASCII fallback with no quote, backslash, percent sign or line break in it
      assert.match(header, /^inline; filename="[\x20-\x7e]*"(; filename\*=UTF-8''[A-Za-z0-9%._~-]*)?$/);
      assert.doesNotMatch(header.match(/^inline; filename="([^;]*?)"/)![1], /["\\%]/);
      assert.doesNotMatch(header, /[\r\n]/);
    }
    assert.equal(
      contentDisposition("ස.png"),
      `inline; filename="_.png"; filename*=UTF-8''%E0%B7%83.png`,
    );
    assert.match(contentDisposition("it's (1)*.png"), /filename\*=UTF-8''it%27s%20%281%29%2A\.png/);
    assert.equal(
      contentDisposition("a.png", "attachment"),
      `attachment; filename="a.png"; filename*=UTF-8''a.png`,
    );
  });

  Deno.test("preview: a Sinhala file name no longer breaks the response", async () => {
    const realFetch = globalThis.fetch;
    try {
      client.from = () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: {
                    telegram_file_id: "tg",
                    file_size: 100,
                    mime_type: "image/png",
                    file_name: "ස.png",
                  },
                }),
            }),
          }),
        }),
      });
      globalThis.fetch = ((input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input);
        return Promise.resolve(
          url.includes("/getFile")
            ? new Response(JSON.stringify({ result: { file_path: "photos/a.png" } }))
            : new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Length": "4" } }),
        );
      }) as typeof fetch;
      const app = new Hono();
      app.onError(handleError);
      app.route("/", fileRoutes);
      const response = await app.request(`/files/${FILE}/preview`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("Content-Disposition")!, /filename\*=UTF-8''%E0%B7%83\.png/);
      await response.arrayBuffer();
    } finally {
      globalThis.fetch = realFetch;
      restore();
    }
  });

  // ---------------------------------------------------------------- 2. renaming

  Deno.test("rename: the stored extension is kept whatever characters it has", () => {
    assert.equal(suffixOf("photo.жб"), "жб");
    assert.equal(suffixOf("noext"), null);
    assert.equal(suffixOf(".hidden"), null);
    assert.equal(suffixOf("trailing."), null);
    assert.equal(renameKeepingExtension("photo.жб", "holiday"), "holiday.жб"); // was "holiday"
    assert.equal(renameKeepingExtension("a.___", "new"), "new.___");
    assert.equal(renameKeepingExtension("a.中文", "new"), "new.中文");
    assert.equal(renameKeepingExtension("a.c++", "new"), "new.c++");
    assert.equal(renameKeepingExtension("a.abcdefghijklmnopq", "x"), "x.abcdefghijklmnopq");
    // typing the extension yourself does not duplicate it, in any case and for any length
    assert.equal(renameKeepingExtension("a.abcdefghijklmnopq", "x.abcdefghijklmnopq"), "x.abcdefghijklmnopq");
    assert.equal(renameKeepingExtension("a.жб", "holiday.ЖБ"), "holiday.жб");
    assert.equal(renameKeepingExtension("a.PNG", "pic.png"), "pic.PNG");
    assert.equal(renameKeepingExtension("a.png", "pic"), "pic.png");
    assert.equal(renameKeepingExtension("README", "docs"), "docs");
    assert.equal(renameKeepingExtension("a.png", "  .png "), null);
    assert.equal(renameKeepingExtension("a.png", "x".repeat(300)), null);
  });

  // ---------------------------------------------------------------- 13. numbers in the query string

  Deno.test("intParam: whole numbers only, clamped, with a fallback", () => {
    assert.equal(intParam("2.7", 1, 1, 100), 2);
    assert.equal(intParam("0", 1, 1, 100), 1);
    assert.equal(intParam("-5", 1, 1, 100), 1);
    assert.equal(intParam("1e9", 1, 1, 100), 100);
    assert.equal(intParam("abc", 50, 1, 100), 50);
    assert.equal(intParam("", 50, 1, 100), 50);
    assert.equal(intParam(undefined, 50, 1, 100), 50);
    assert.equal(intParam("Infinity", 50, 1, 100), 50);
    assert.equal(intParam(" 7 ", 1, 1, 100), 7);
  });

  /** A files query that records what the route asked for. */
  function listingDb(calls: { ilike: unknown[][]; not: unknown[][]; range: unknown[][] }) {
    // deno-lint-ignore no-explicit-any
    const builder: any = {
      select: () => builder,
      eq: () => builder,
      is: () => builder,
      order: () => builder,
      range: (...args: unknown[]) => (calls.range.push(args), builder),
      ilike: (...args: unknown[]) => (calls.ilike.push(args), builder),
      not: (...args: unknown[]) => (calls.not.push(args), builder),
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: [], count: 0, error: null }).then(resolve),
    };
    client.from = () => builder;
  }

  Deno.test("files list: ?type= only accepts the real types; page and limit are whole numbers", async () => {
    try {
      const calls = { ilike: [] as unknown[][], not: [] as unknown[][], range: [] as unknown[][] };
      listingDb(calls);
      const app = new Hono();
      app.onError(handleError);
      app.route("/", fileRoutes);
      for (const type of ["constructor", "toString", "__proto__", "hasOwnProperty", "nope"]) {
        assert.equal((await app.request(`/files?type=${type}`)).status, 200);
      }
      assert.deepEqual(calls.ilike, [], "no inherited property is ever used as a filter");
      await app.request("/files?type=image");
      assert.deepEqual(calls.ilike, [["mime_type", "image/%"]]);
      await app.request("/files?type=document");
      assert.equal(calls.not.length, 3);

      calls.range.length = 0;
      assert.equal((await app.request("/files?page=2.7&limit=2.5")).status, 200);
      assert.deepEqual(calls.range[0], [2, 3]); // page 2, limit 2 -> rows 2..3, whole numbers only
      calls.range.length = 0;
      await app.request("/files?page=abc&limit=1e9");
      assert.deepEqual(calls.range[0], [0, 99]);
    } finally {
      restore();
    }
  });

  // ---------------------------------------------------------------- 5. webhook timeout

  Deno.test("webhook: a slow update is acknowledged (200), not answered with an error that makes Telegram resend", async () => {
    assert.ok(WEBHOOK_TIMEOUT_MS > 10_000);
    const botInfo = {
      id: 1,
      is_bot: true,
      first_name: "t",
      username: "t_bot",
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
    };
    let finished = false;
    const slow = // deno-lint-ignore no-explicit-any
      new Bot("1:t", { botInfo: botInfo as any });
    slow.on("message", async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      finished = true;
    });
    const update = JSON.stringify({
      update_id: 1,
      message: { message_id: 1, date: 1, chat: { id: 1, type: "private" }, text: "hi" },
    });
    const request = () =>
      new Request("https://x.test/hook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: update,
      });

    const ack = await webhookCallback(slow, "std/http", { onTimeout: "return", timeoutMilliseconds: 50 })(
      request(),
    );
    assert.equal(ack.status, 200);
    assert.equal(finished, false); // answered while the work is still running...
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(finished, true); // ...and it still completes in the background

    // what the old default did: the error answer that makes Telegram send the update again
    await assert.rejects(
      () => webhookCallback(slow, "std/http", { timeoutMilliseconds: 50 })(request()),
      /timed out/,
    );
  });

  // ---------------------------------------------------------------- 9. bot button errors

  Deno.test("bot helpers: 'message is not modified' is not a failure; a failed button is always answered", async () => {
    assert.equal(
      isNotModified({ description: "Bad Request: message is not modified: specified new message content" }),
      true,
    );
    assert.equal(isNotModified(new Error("Bad Request: message is not modified")), true);
    assert.equal(isNotModified({ description: "Bad Request: message to edit not found" }), false);
    assert.equal(isNotModified(null), false);

    await editQuietly(() => Promise.reject({ description: "Bad Request: message is not modified" })); // swallowed
    await assert.rejects(() => editQuietly(() => Promise.reject(new Error("network"))), /network/);

    const answers: unknown[] = [];
    await answerFailure({
      callbackQuery: {},
      answerCallbackQuery: (other) => (answers.push(other), Promise.resolve(true)),
    });
    assert.equal(answers.length, 1);
    await answerFailure({
      callbackQuery: undefined,
      answerCallbackQuery: () => Promise.reject(new Error("must not be called")),
    });
    await answerFailure({
      callbackQuery: {},
      answerCallbackQuery: () => Promise.reject(new Error("already answered")),
    }); // never throws
  });

  // ---------------------------------------------------------------- 10. Telegram sign-in during an outage

  async function signedInitData(userId: number, token = config.botToken) {
    const enc = new TextEncoder();
    const hmac = async (key: ArrayBuffer | string, data: string) =>
      await crypto.subtle.sign(
        "HMAC",
        await crypto.subtle.importKey(
          "raw",
          typeof key === "string" ? enc.encode(key) : key,
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        ),
        enc.encode(data),
      );
    const params = new URLSearchParams({
      auth_date: String(Math.floor(Date.now() / 1000)),
      query_id: "AAH",
      user: JSON.stringify({ id: userId, first_name: "Owner" }),
    });
    const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`)
      .join(
        "\n",
      );
    const secret = await hmac("WebAppData", token);
    const hash = [...new Uint8Array(await hmac(secret, check))].map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    params.set("hash", hash);
    return params.toString();
  }

  Deno.test("Telegram sign-in: bad signature is 401, a database outage is 503 (not 'session out of date')", async () => {
    try {
      const app = new Hono();
      app.onError(handleError);
      app.route("/api/auth", publicAuth);
      const post = (initData: string) =>
        app.request("/api/auth/telegram", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ initData }),
        });

      client.from = () => ({
        upsert: () => Promise.resolve({ error: null }),
        select: () => ({
          eq: () => ({ maybeSingle: () => Promise.resolve({ data: { session_version: 1 }, error: null }) }),
        }),
      });
      const good = await post(await signedInitData(config.ownerId));
      assert.equal(good.status, 200);
      assert.ok((await good.json() as { token: string }).token);

      assert.equal((await post("auth_date=1&hash=" + "0".repeat(64))).status, 401);
      assert.equal((await post(await signedInitData(config.ownerId, "999:other-token"))).status, 401);
      assert.equal((await post(await signedInitData(config.ownerId + 1))).status, 401); // not the owner

      client.from = () => ({
        upsert: () => Promise.resolve({ error: { message: "boom" } }),
        select: () => ({
          eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: "boom" } }) }),
        }),
      });
      const outage = await post(await signedInitData(config.ownerId));
      assert.equal(outage.status, 503);
      assert.equal(outage.headers.get("Retry-After"), "5");
    } finally {
      restore();
    }
  });

  // ---------------------------------------------------------------- 11. database errors are not swallowed

  Deno.test("folderExists / getSetting: a database failure is an error, not 'not found' or 'no value'", async () => {
    try {
      const failing = {
        select: () => ({
          eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: "boom" } }) }),
        }),
      };
      client.from = () => failing;
      await assert.rejects(() => folderExists(FILE), ServiceUnavailableError);
      await assert.rejects(() => getSetting("incoming_folder_id"), ServiceUnavailableError);
      const empty = {
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
      };
      client.from = () => empty;
      assert.equal(await folderExists(FILE), false); // really missing is still just "false"
      assert.equal(await folderExists(null), true);
      assert.equal(await getSetting("x"), undefined);
    } finally {
      restore();
    }
  });

  Deno.test("API: moving a file during a database outage is 503, not 'destination not found'", async () => {
    try {
      client.from = () => ({
        select: () => ({
          eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: "boom" } }) }),
        }),
      });
      const app = new Hono();
      app.onError(handleError);
      app.route("/", fileRoutes);
      const response = await app.request(`/files/${FILE}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder_id: "33333333-3333-4333-8333-333333333333" }),
      });
      assert.equal(response.status, 503);
    } finally {
      restore();
    }
  });

  Deno.test("upload: duplicate checks that fail stop the upload (nothing is copied, nothing lands in the wrong folder)", async () => {
    const realCopy = bot.api.copyMessage;
    let copies = 0;
    try {
      // deno-lint-ignore no-explicit-any
      (bot.api as any).copyMessage = () => (copies++, Promise.resolve({ message_id: 9 }));
      const message = {
        message_id: 501,
        chat: { id: 7 },
        date: 1,
        document: {
          file_id: "f",
          file_unique_id: "u",
          file_name: "a.png",
          mime_type: "image/png",
          file_size: 10,
        },
        // deno-lint-ignore no-explicit-any
      } as any;
      // 1) the same-message check fails
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select: () => chain,
        match: () => chain,
        is: () => chain,
        eq: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve({ data: null, error: { message: "boom" } }),
      };
      client.from = () => chain;
      await assert.rejects(() => storeIncoming(message), ServiceUnavailableError);
      // 2) the same-content check fails (the first one is fine)
      let calls = 0;
      chain.maybeSingle = () =>
        Promise.resolve(
          ++calls === 1 ? { data: null, error: null } : { data: null, error: { message: "boom" } },
        );
      await assert.rejects(() => storeIncoming({ ...message, message_id: 502 }), ServiceUnavailableError);
      assert.equal(copies, 0);
    } finally {
      bot.api.copyMessage = realCopy;
      restore();
    }
  });

  // ---------------------------------------------------------------- 12. session changes are atomic

  Deno.test("sign out everywhere / credential changes: one atomic database call, and failures are reported", async () => {
    try {
      const calls: Array<{ name: string; args: unknown }> = [];
      client.from = () => ({ insert: () => Promise.resolve({ error: null }) });
      client.rpc = (
        name: string,
        args: unknown,
      ) => (calls.push({ name, args }), Promise.resolve({ data: 5, error: null }));
      const session = new Hono();
      session.onError(handleError);
      session.use("*", async (c, next) => {
        // deno-lint-ignore no-explicit-any
        (c as any).set("session", {
          sub: 42,
          via: "telegram",
          iat: Date.now() - 600_000,
          at: Date.now() - 60_000, // the Mini App was opened a minute ago
          exp: Date.now() + 3_600_000,
          v: 1,
        });
        await next();
      });
      session.route("/", privateAuth);

      assert.equal((await session.request("/logout-all", { method: "POST" })).status, 200);
      assert.deepEqual(calls[0], { name: "bump_session_version", args: { p_telegram_id: config.ownerId } });

      client.rpc = () => Promise.resolve({ data: null, error: { message: "boom" } });
      assert.equal((await session.request("/logout-all", { method: "POST" })).status, 503); // never "success" without a change

      // password setup: the owner row exists but browser sign-in is not on yet
      client.from = (table: string) =>
        table === "users"
          ? {
            select: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({ data: { password_enabled: false, login_username: null }, error: null }),
              }),
            }),
          }
          : { insert: () => Promise.resolve({ error: null }) };
      const setup = (body: unknown) =>
        session.request("/password/setup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      const credentials = { username: "owner", password: "correct-horse-battery-1" };
      client.rpc = (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return Promise.resolve({ data: 7, error: null });
      };
      const ok = await setup(credentials);
      assert.equal(ok.status, 200);
      assert.ok((await ok.json() as { token: string }).token);
      const saved = calls.at(-1)!;
      assert.equal(saved.name, "set_owner_credentials");
      assert.equal((saved.args as { p_username: string }).p_username, "owner");
      assert.equal((saved.args as { p_iterations: number }).p_iterations, 600_000);

      client.rpc = () => Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key" } });
      assert.equal((await setup(credentials)).status, 409);
      client.rpc = () => Promise.resolve({ data: null, error: { code: "XX000", message: "boom" } });
      assert.equal((await setup(credentials)).status, 500);
    } finally {
      restore();
    }
  });
}

// ======================================================================
// batch6 (was batch6_test.ts)
// ======================================================================
{
  Deno.env.set("BOT_USERNAME", "ci_bot");
  const { db } = await import("./db.ts");
  const { config } = await import("./config.ts");
  const {
    createSession,
    verifySession,
    isRecentSignIn,
    verifyMiniAppInitData,
    hashPassword,
    RECENT_SIGNIN_MS,
  } = await import("./security.ts");
  const { publicAuth, privateAuth } = await import("./routes/auth.ts");
  const { fileRoutes } = await import("./routes/files.ts");
  const { systemRoutes } = await import("./routes/system.ts");
  const { handleError } = await import("./http.ts");
  const { bot, deleteChannelMessages, retryPendingDeletions, MAX_DELETE_ATTEMPTS, messageAlreadyGone } =
    await import("./telegram.ts");
  const { deliverShare } = await import("./share.ts");
  const { ownerGuard } = await import("./botErrors.ts");
  const { runMaintenance } = await import("./maintenance.ts");
  const { escapeLike, lastPage, recentWebhookError, WEBHOOK_ERROR_WINDOW_MS } = await import("./lib.ts");
  const { AlbumReports } = await import("./album.ts");

  // deno-lint-ignore no-explicit-any
  const client = db as any;
  const realFrom = client.from;
  const realRpc = client.rpc;
  const restore = () => {
    client.from = realFrom;
    client.rpc = realRpc;
  };
  const json = (method: string, body: unknown) => ({
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  // ============================================================ 1. old launch data is not a recent sign-in

  async function signedInitData(authAgeSeconds: number, userId = config.ownerId) {
    const enc = new TextEncoder();
    const hmac = async (key: ArrayBuffer | string, data: string) =>
      await crypto.subtle.sign(
        "HMAC",
        await crypto.subtle.importKey(
          "raw",
          typeof key === "string" ? enc.encode(key) : key,
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        ),
        enc.encode(data),
      );
    const authDate = Math.floor(Date.now() / 1000) - authAgeSeconds;
    const params = new URLSearchParams({
      auth_date: String(authDate),
      query_id: "AAH",
      user: JSON.stringify({ id: userId, first_name: "Owner" }),
    });
    const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`)
      .join(
        "\n",
      );
    const hash = [...new Uint8Array(await hmac(await hmac("WebAppData", config.botToken), check))].map((b) =>
      b.toString(16).padStart(2, "0")
    ).join("");
    params.set("hash", hash);
    return { initData: params.toString(), authDate };
  }

  Deno.test("verifyMiniAppInitData returns the launch time", async () => {
    const { initData, authDate } = await signedInitData(120);
    assert.equal((await verifyMiniAppInitData(initData)).auth_date, authDate);
  });

  Deno.test("isRecentSignIn: only a Telegram session whose LAUNCH was recent counts", () => {
    const now = Date.now();
    const base = { sub: 42, exp: now + 1e6, v: 1 };
    assert.equal(isRecentSignIn({ ...base, via: "telegram", iat: now - 5_000, at: now - 5_000 }, now), true);
    assert.equal(
      isRecentSignIn({ ...base, via: "telegram", iat: now - 1_000, at: now - 23 * 3600_000 }, now),
      false,
    ); // fresh session, old launch
    assert.equal(
      isRecentSignIn({ ...base, via: "telegram", iat: now - 1_000, at: now - RECENT_SIGNIN_MS }, now),
      false,
    );
    assert.equal(
      isRecentSignIn({ ...base, via: "telegram", iat: now - 1_000, at: now - RECENT_SIGNIN_MS + 1_000 }, now),
      true,
    );
    assert.equal(isRecentSignIn({ ...base, via: "password", iat: now, at: now }, now), false);
    assert.equal(isRecentSignIn({ ...base, via: "telegram", iat: now - 60_000 }, now), true); // token from before this change: iat is used
    assert.equal(isRecentSignIn({ ...base, via: "telegram", iat: now - 3600_000 }, now), false);
    assert.equal(isRecentSignIn({ ...base, via: "telegram", iat: now, at: now + 3600_000 }, now), false); // a launch time in the future is not trusted
  });

  Deno.test("createSession: the launch time can never be later than now", async () => {
    const token = await createSession(config.ownerId, 1, "telegram", undefined, Date.now() + 3600_000);
    const claims = await verifySession(token);
    assert.ok(claims && claims.at! <= Date.now());
  });

  Deno.test("POST /telegram: the session remembers the launch time (day-old launch data is accepted but not recent)", async () => {
    try {
      client.from = () => ({
        upsert: () => Promise.resolve({ error: null }),
        select: () => ({
          eq: () => ({ maybeSingle: () => Promise.resolve({ data: { session_version: 1 }, error: null }) }),
        }),
      });
      const app = new Hono();
      app.onError(handleError);
      app.route("/api/auth", publicAuth);
      for (const [age, recent] of [[20, true], [23 * 3600, false]] as const) {
        const { initData, authDate } = await signedInitData(age);
        const response = await app.request("/api/auth/telegram", json("POST", { initData }));
        assert.equal(response.status, 200);
        const claims = await verifySession((await response.json() as { token: string }).token);
        assert.equal(claims!.at, authDate * 1000);
        assert.equal(isRecentSignIn(claims!), recent, `launch ${age}s ago`);
      }
    } finally {
      restore();
    }
  });

  /** The signed-in routes, with a session whose Mini App launch was `launchAgeMs` ago. */
  function sessionApp(launchAgeMs: number, via: "telegram" | "password" = "telegram") {
    const at = Date.now() - launchAgeMs;
    const app = new Hono();
    app.onError(handleError);
    app.use("*", async (c, next) => {
      // deno-lint-ignore no-explicit-any
      (c as any).set("session", {
        sub: config.ownerId,
        via,
        iat: Date.now() - 1_000,
        at,
        exp: Date.now() + 3_600_000,
        v: 1,
      });
      await next();
    });
    app.route("/", privateAuth);
    return { app, at };
  }

  Deno.test("password setup needs a recent Telegram launch; /me says whether you have one", async () => {
    try {
      client.from = (table: string) =>
        table === "users"
          ? {
            select: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({ data: { password_enabled: false, login_username: null }, error: null }),
              }),
            }),
          }
          : { insert: () => Promise.resolve({ error: null }) };
      client.rpc = () => Promise.resolve({ data: 3, error: null });
      const credentials = { username: "owner", password: "correct-horse-battery-1" };

      const stale = sessionApp(23 * 3600_000).app;
      const refused = await stale.request("/password/setup", json("POST", credentials));
      assert.equal(refused.status, 403);
      assert.match((await refused.json() as { error: string }).error, /open Cloud Drive again from Telegram/);
      assert.equal(
        (await (await stale.request("/me")).json() as { recent_sign_in: boolean }).recent_sign_in,
        false,
      );

      const recent = sessionApp(30_000);
      const ok = await recent.app.request("/password/setup", json("POST", credentials));
      assert.equal(ok.status, 200);
      assert.equal(
        (await (await recent.app.request("/me")).json() as { recent_sign_in: boolean }).recent_sign_in,
        true,
      );
      // the new session keeps the SAME launch time (setting a password does not make the session look newer)
      assert.equal((await verifySession((await ok.json() as { token: string }).token))!.at, recent.at);
    } finally {
      restore();
    }
  });

  Deno.test("changing credentials: an old Telegram launch must give the current password", async () => {
    try {
      const stored = await hashPassword("old-password-123");
      client.from = (table: string) =>
        table === "users"
          ? {
            select: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: {
                      password_enabled: true,
                      login_username: "owner",
                      password_hash: stored.hash,
                      password_salt: stored.salt,
                      password_iterations: stored.iterations,
                    },
                    error: null,
                  }),
              }),
            }),
          }
          : {
            delete: () => ({ in: () => Promise.resolve({ error: null }) }),
            insert: () => Promise.resolve({ error: null }),
          };
      client.rpc = (name: string) =>
        Promise.resolve({ data: name === "reserve_login_attempt" ? true : 9, error: null });
      const change = { username: "owner", password: "brand-new-password-9" };

      const stale = sessionApp(23 * 3600_000).app;
      assert.equal((await stale.request("/password", json("PATCH", change))).status, 403); // no current password
      assert.equal(
        (await stale.request("/password", json("PATCH", { ...change, current_password: "wrong-password-1" })))
          .status,
        403,
      );
      assert.equal(
        (await stale.request("/password", json("PATCH", { ...change, current_password: "old-password-123" })))
          .status,
        200,
      );

      const recent = sessionApp(30_000).app; // opened from Telegram a moment ago: no current password needed
      assert.equal((await recent.request("/password", json("PATCH", change))).status, 200);
    } finally {
      restore();
    }
  });

  // ============================================================ 2. long id lists are sent to the database in groups

  Deno.test("batch move / copy / trash: up to 200 ids work and no database request carries more than 100", async () => {
    try {
      const ids = Array.from({ length: 150 }, () => crypto.randomUUID());
      const inSizes: number[] = [];
      let inserted = 0;
      client.from = (table: string) => {
        if (table !== "files") return { insert: () => Promise.resolve({ error: null }) };
        // deno-lint-ignore no-explicit-any
        const chain: any = {
          rows: [] as string[],
          select: () => chain,
          update: () => chain,
          insert: (
            rows: unknown[],
          ) => ((inserted += rows.length), {
            select: () =>
              Promise.resolve({ data: rows.map(() => ({ id: crypto.randomUUID() })), error: null }),
          }),
          in: (_column: string, part: string[]) => (inSizes.push(part.length), (chain.rows = part), chain),
          eq: () => chain,
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve({
              data: chain.rows.map((id: string) => ({ id, file_name: "a.png", mime_type: "image/png" })),
              error: null,
            }).then(resolve),
        };
        return chain;
      };
      const app = new Hono();
      app.onError(handleError);
      app.route("/", fileRoutes);
      // move looks the files up and then updates them (2 x 150 ids); copy only looks up; trash only updates
      for (
        const [path, expectedTotal] of [["/files/batch/move", 300], ["/files/batch/copy", 150], [
          "/files/batch/trash",
          150,
        ]] as const
      ) {
        inSizes.length = 0;
        const response = await app.request(path, json("POST", { file_ids: ids }));
        assert.ok(response.status === 200 || response.status === 201, `${path} -> ${response.status}`);
        assert.ok(
          inSizes.every((size) => size <= 100),
          `${path}: no request carries more than 100 ids (${inSizes})`,
        );
        assert.equal(
          inSizes.reduce((sum, size) => sum + size, 0),
          expectedTotal,
          `${path}: every id is covered`,
        );
      }
      assert.equal(inserted, 150); // the copy really covered every file
      const tooMany = await app.request(
        "/files/batch/trash",
        json("POST", { file_ids: Array.from({ length: 201 }, () => crypto.randomUUID()) }),
      );
      assert.equal(tooMany.status, 400);
    } finally {
      restore();
    }
  });

  // ============================================================ 4. webhook status

  Deno.test("recentWebhookError: old delivery errors are history, recent ones are real", () => {
    const now = Date.now();
    const at = (agoMs: number) => Math.floor((now - agoMs) / 1000);
    assert.deepEqual(recentWebhookError({}, now), { message: null, at: null });
    assert.equal(
      recentWebhookError({ last_error_message: "timeout", last_error_date: at(60_000) }, now).message,
      "timeout",
    );
    const old = recentWebhookError({
      last_error_message: "timeout",
      last_error_date: at(WEBHOOK_ERROR_WINDOW_MS + 60_000),
    }, now);
    assert.equal(old.message, null);
    assert.ok(old.at); // the date is still reported
    assert.equal(recentWebhookError({ last_error_message: "x" }, now).message, "x"); // no date: assume it is current
  });

  Deno.test("/status: an old webhook error no longer keeps the webhook red", async () => {
    const original = {
      me: bot.api.getMe,
      info: bot.api.getWebhookInfo,
      chat: bot.api.getChat,
      member: bot.api.getChatMember,
    };
    try {
      client.from = () => ({ select: () => Promise.resolve({ error: null }) });
      // deno-lint-ignore no-explicit-any
      const api = bot.api as any;
      api.getMe = () => Promise.resolve({ id: 1, username: "ci_bot" });
      api.getChat = () => Promise.resolve({ title: "Storage" });
      api.getChatMember = () => Promise.resolve({ status: "administrator", can_post_messages: true });
      const app = new Hono();
      app.route("/", systemRoutes);
      const status = async (lastErrorAgoMs: number | null) => {
        api.getWebhookInfo = () =>
          Promise.resolve({
            url: "https://x.test/hook",
            pending_update_count: 0,
            ...(lastErrorAgoMs === null ? {} : {
              last_error_message: "Wrong response from the webhook: 500",
              last_error_date: Math.floor((Date.now() - lastErrorAgoMs) / 1000),
            }),
          });
        return (await (await app.request("/status")).json() as {
          webhook: { ok: boolean; last_error: string | null };
        }).webhook;
      };
      assert.equal((await status(null)).ok, true);
      assert.equal((await status(5 * 60_000)).ok, false); // 5 minutes ago: still a problem
      assert.equal((await status(5 * 60_000)).last_error, "Wrong response from the webhook: 500");
      const healed = await status(26 * 3600_000); // yesterday, since fixed
      assert.equal(healed.ok, true);
      assert.equal(healed.last_error, null);
    } finally {
      // deno-lint-ignore no-explicit-any
      const api = bot.api as any;
      api.getMe = original.me;
      api.getWebhookInfo = original.info;
      api.getChat = original.chat;
      api.getChatMember = original.member;
      restore();
    }
  });

  // ============================================================ 5. share links and database errors

  Deno.test("share link: a database failure is an error to retry, never 'no longer valid'", async () => {
    try {
      const replies: string[] = [];
      const ctx = {
        chat: { id: 5 },
        reply: (text: string) => (replies.push(text), Promise.resolve()),
        api: { copyMessage: () => Promise.resolve() },
      };
      // deno-lint-ignore no-explicit-any
      const asContext = ctx as any;
      client.from = () => ({
        select: () => ({
          eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: "boom" } }) }),
        }),
      });
      await assert.rejects(() => deliverShare(asContext, "tok"), /Unable to look up the share link/);
      assert.deepEqual(replies, []);

      // the link exists but loading the file fails
      let call = 0;
      client.from = () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: "boom" } }) }),
            maybeSingle: () =>
              Promise.resolve(
                ++call === 1 ? { data: { file_id: "f" }, error: null } : { data: null, error: null },
              ),
          }),
        }),
      });
      await assert.rejects(() => deliverShare(asContext, "tok"), /Unable to load the shared file/);

      // a really missing link is still reported as such
      client.from = () => ({
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
      });
      await deliverShare(asContext, "tok");
      assert.match(replies[0], /no longer valid/);
    } finally {
      restore();
    }
  });

  // ============================================================ 6. failed channel deletions are retried

  /** A fake database for the retry queue: records what is upserted, updated and deleted. */
  function queueDb(
    rows: Array<{ chat_id: number; message_id: number; attempts: number }>,
    referenced: Set<number> = new Set(),
  ) {
    const log = { upserts: [] as unknown[], updates: [] as unknown[], deletes: [] as unknown[] };
    client.from = (table: string) => {
      if (table === "files") {
        const state = { message: 0 };
        // deno-lint-ignore no-explicit-any
        const chain: any = {
          select: () => chain,
          eq: (
            column: string,
            value: number,
          ) => (column === "telegram_message_id" && (state.message = value), chain),
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve({ count: referenced.has(state.message) ? 1 : 0, error: null }).then(resolve),
        };
        return chain;
      }
      return {
        upsert: (
          row: unknown,
          options: unknown,
        ) => (log.upserts.push({ row, options }), Promise.resolve({ error: null })),
        select: () => ({
          lte: () => ({ order: () => ({ limit: () => Promise.resolve({ data: rows, error: null }) }) }),
        }),
        update: (values: unknown) => ({
          match: (key: unknown) => (log.updates.push({ values, key }), Promise.resolve({ error: null })),
        }),
        delete: () => ({
          match: (key: unknown) => (log.deletes.push(key), Promise.resolve({ error: null })),
        }),
      };
    };
    return log;
  }

  Deno.test("channel messages that cannot be deleted are remembered, not forgotten", async () => {
    const realDelete = bot.api.deleteMessage;
    try {
      const log = queueDb([]);
      // deno-lint-ignore no-explicit-any
      (bot.api as any).deleteMessage = (_chat: number, message: number) =>
        message === 1
          ? Promise.resolve(true)
          : message === 2
          ? Promise.reject({ description: "Bad Request: message to delete not found" })
          : Promise.reject({ description: "Bad Request: message can't be deleted" });
      const deleted = await deleteChannelMessages([{ tg_chat_id: -100, tg_message_id: 1 }, {
        tg_chat_id: -100,
        tg_message_id: 2,
      }, { tg_chat_id: -100, tg_message_id: 3 }]);
      assert.equal(deleted, 2); // deleted + already gone
      assert.equal(log.upserts.length, 1);
      const queued = log.upserts[0] as {
        row: { chat_id: number; message_id: number; attempts: number };
        options: { onConflict: string };
      };
      assert.deepEqual([queued.row.chat_id, queued.row.message_id, queued.row.attempts], [-100, 3, 1]);
      assert.equal(queued.options.onConflict, "chat_id,message_id");
      assert.equal(messageAlreadyGone({ description: "Bad Request: message to delete not found" }), true);
      assert.equal(messageAlreadyGone(new Error("network")), false);
    } finally {
      bot.api.deleteMessage = realDelete;
      restore();
    }
  });

  Deno.test("retry job: finishes, counts attempts, gives up after the limit and never deletes a message a file still uses", async () => {
    const realDelete = bot.api.deleteMessage;
    try {
      const tried: number[] = [];
      // deno-lint-ignore no-explicit-any
      (bot.api as any).deleteMessage = (_chat: number, message: number) => {
        tried.push(message);
        return message === 10
          ? Promise.resolve(true)
          : Promise.reject({ description: "Bad Request: message can't be deleted" });
      };
      const log = queueDb(
        [
          { chat_id: -100, message_id: 10, attempts: 1 }, // works now
          { chat_id: -100, message_id: 20, attempts: 1 }, // fails again, tries left
          { chat_id: -100, message_id: 30, attempts: MAX_DELETE_ATTEMPTS - 1 }, // last try fails: give up
          { chat_id: -100, message_id: 40, attempts: 1 }, // a file points at it again: leave the message alone
        ],
        new Set([40]),
      );
      const result = await retryPendingDeletions();
      assert.deepEqual(result, { deleted: 1, gaveUp: 1, processed: 4 });
      assert.deepEqual(tried, [10, 20, 30]); // 40 was never touched
      assert.deepEqual(log.deletes.map((key) => (key as { message_id: number }).message_id).sort(), [
        10,
        30,
        40,
      ]);
      assert.deepEqual(
        log.updates.map((entry) => (entry as { values: { attempts: number } }).values.attempts),
        [2],
      );
    } finally {
      bot.api.deleteMessage = realDelete;
      restore();
    }
  });

  // ============================================================ minor and additional

  Deno.test("maintenance: cleanup failures are logged, and queued deletions are retried", async () => {
    const realError = console.error;
    const logged: string[] = [];
    try {
      console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
      client.rpc = () => Promise.resolve({ data: [], error: null });
      client.from = (table: string) => {
        if (table === "activity_logs") {
          return {
            delete: () => ({
              lt: () => Promise.resolve({ count: null, error: { message: "activity boom" } }),
            }),
          };
        }
        if (table === "login_attempts") {
          return { delete: () => ({ lt: () => Promise.resolve({ error: { message: "attempts boom" } }) }) };
        }
        if (table === "revoked_sessions") {
          return { delete: () => ({ lt: () => Promise.resolve({ error: null }) }) };
        }
        if (table === "album_reports") {
          return { delete: () => ({ lt: () => Promise.resolve({ error: { message: "albums boom" } }) }) };
        }
        return {
          select: () => ({
            lte: () => ({ order: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }) }),
          }),
        };
      };
      const result = await runMaintenance();
      assert.equal(result.deletedMessages, 0);
      assert.ok(logged.some((line) => line.includes("albums boom")));
      assert.ok(logged.some((line) => line.includes("activity boom")));
      assert.ok(logged.some((line) => line.includes("attempts boom")));
    } finally {
      console.error = realError;
      restore();
    }
  });

  Deno.test("search text: a typed * can no longer swallow arbitrary text", () => {
    assert.equal(escapeLike("a*b"), "a_b");
    assert.equal(escapeLike("50%_x\\"), "50\\%\\_x\\\\");
    assert.equal(escapeLike("***"), "___");
  });

  Deno.test("lastPage: never below 1", () => {
    assert.equal(lastPage(0, 8), 1);
    assert.equal(lastPage(8, 8), 1);
    assert.equal(lastPage(9, 8), 2);
    assert.equal(lastPage(100, 8), 13);
  });

  Deno.test("bot guard: strangers are ignored, but a tapped button is always answered", async () => {
    const guard = ownerGuard(42);
    const calls: string[] = [];
    const make = (from: number | undefined, extra: Record<string, unknown> = {}) => ({
      from: from === undefined ? undefined : { id: from },
      answerCallbackQuery: (
        other?: { text?: string },
      ) => (calls.push(`answer:${other?.text}`), Promise.resolve()),
      ...extra,
    });
    const next = () => (calls.push("next"), Promise.resolve());
    await guard(make(42), next);
    await guard(make(7, { message: { text: "/start share_abc" } }), next); // anyone may open a share link
    await guard(make(7, { message: { text: "/files" } }), next);
    assert.deepEqual(calls, ["next", "next"]);
    await guard(make(7, { callbackQuery: {} }), next);
    assert.deepEqual(calls.slice(2), ["answer:This button is not for you."]);
    const failing = make(7, {
      callbackQuery: {},
      answerCallbackQuery: () => Promise.reject(new Error("too old")),
    });
    await guard(failing, next); // must not throw
  });

  Deno.test("album status: queued edits that would say the same thing are not sent", async () => {
    const reports = new AlbumReports();
    const edits: string[] = [];
    const edit = (_id: number, text: string) => (edits.push(text), Promise.resolve());
    const [a, b, c] = ["k", "k", "k"].map(() => reports.join("k", () => Promise.resolve(1), edit));
    await Promise.all([a.record("saved"), b.record("saved"), c.record("saved")]);
    assert.equal(new Set(edits).size, edits.length, "no identical edits");
    assert.equal(edits.at(-1), "✅ Album: 3 saved.");
  });

  Deno.test("files list: no folder_id means the top level (like the folder list); bad ids are 400", async () => {
    try {
      const calls = { is: [] as unknown[][], eq: [] as unknown[][] };
      // deno-lint-ignore no-explicit-any
      const builder: any = {
        select: () => builder,
        order: () => builder,
        range: () => builder,
        ilike: () => builder,
        not: () => builder,
        is: (...args: unknown[]) => (calls.is.push(args), builder),
        eq: (...args: unknown[]) => (calls.eq.push(args), builder),
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({ data: [], count: 0, error: null }).then(resolve),
      };
      client.from = () => builder;
      const app = new Hono();
      app.onError(handleError);
      app.route("/", fileRoutes);
      const folder = crypto.randomUUID();
      const bodyOf = async (query: string) => (await app.request(`/files${query}`)).status;
      assert.equal(await bodyOf(""), 200);
      assert.deepEqual(
        calls.is,
        [["folder_id", null], ["status", "active"] as unknown[]].slice(0, 1).concat(calls.is.slice(1)).slice(
          0,
          calls.is.length,
        ),
      );
      assert.ok(calls.is.some((args) => args[0] === "folder_id" && args[1] === null), "top level");
      calls.is.length = 0;
      calls.eq.length = 0;
      assert.equal(await bodyOf(`?folder_id=${folder}`), 200);
      assert.ok(calls.eq.some((args) => args[0] === "folder_id" && args[1] === folder));
      calls.is.length = 0;
      calls.eq.length = 0;
      assert.equal(await bodyOf("?global=1&q=x"), 200);
      assert.ok(
        !calls.is.some((args) => args[0] === "folder_id") &&
          !calls.eq.some((args) => args[0] === "folder_id"),
        "global search ignores folders",
      );
      assert.equal(await bodyOf("?folder_id=not-a-uuid"), 400);
    } finally {
      restore();
    }
  });

  Deno.test("rename: a database failure is 503, not 'file not found'", async () => {
    try {
      client.from = () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: "boom" } }) }),
          }),
        }),
      });
      const app = new Hono();
      app.onError(handleError);
      app.route("/", fileRoutes);
      const response = await app.request(
        `/files/${crypto.randomUUID()}`,
        json("PATCH", { file_name: "new" }),
      );
      assert.equal(response.status, 503);
    } finally {
      restore();
    }
  });

  Deno.test("empty Trash reports files and deleted folders", async () => {
    try {
      const logged: unknown[] = [];
      client.from = (table: string) =>
        table === "trashed_folders"
          ? { select: () => Promise.resolve({ count: 4, error: null }) }
          : table === "pending_message_deletions"
          ? {
            select: () => ({
              lte: () => ({ order: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }) }),
            }),
          }
          : { insert: (row: unknown) => (logged.push(row), Promise.resolve({ error: null })) };
      client.rpc = () =>
        Promise.resolve({
          data: [{ tg_chat_id: -1, tg_message_id: 1, orphaned: false }, {
            tg_chat_id: -1,
            tg_message_id: 2,
            orphaned: false,
          }],
          error: null,
        });
      const app = new Hono();
      app.onError(handleError);
      app.route("/", fileRoutes);
      const response = await app.request("/trash/empty", { method: "POST" });
      assert.deepEqual(await response.json(), { ok: true, count: 2, folders: 4 });
      assert.deepEqual((logged[0] as { details: unknown }).details, { count: 2, folders: 4 });
    } finally {
      restore();
    }
  });
}

// ======================================================================
// batch7 (was batch7_test.ts)
// ======================================================================
{
  Deno.env.set("BOT_USERNAME", "ci_bot");
  const { db } = await import("./db.ts");
  const { config } = await import("./config.ts");
  const { redactSecrets, describeError, logError } = await import("./redact.ts");
  const { handleError } = await import("./http.ts");
  const { formatSize } = await import("./lib.ts");
  const { formatSize: frontendFormatSize } = await import("../frontend/src/format.ts");
  const { storeIncoming } = await import("./storage.ts");
  const { bot, retryPendingDeletions, drainPendingDeletions } = await import("./telegram.ts");
  const { encryptToken, decryptToken, createSession, verifySession, RECENT_SIGNIN_MS } = await import(
    "./security.ts"
  );
  const { publicAuth, privateAuth } = await import("./routes/auth.ts");
  const { fileRoutes } = await import("./routes/files.ts");

  // deno-lint-ignore no-explicit-any
  const client = db as any;
  const realFrom = client.from;
  const realRpc = client.rpc;
  const restore = () => {
    client.from = realFrom;
    client.rpc = realRpc;
  };
  const json = (method: string, body?: unknown) => ({
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const FILE = "22222222-2222-4222-8222-2222222222f1";

  // ================================================================ 3. the bot token never reaches a log

  Deno.test("redactSecrets: the bot token is removed from any text, in any URL form", () => {
    const token = config.botToken;
    const urls = [
      `https://api.telegram.org/bot${token}/getFile?file_id=x`,
      `https://api.telegram.org/file/bot${token}/photos/a.png`,
      `request to https://api.telegram.org/bot987654321:AAH-fake_Token-0123456789abcdefghijk/getMe failed`,
      `token=${token}`,
    ];
    for (const url of urls) {
      const out = redactSecrets(url);
      assert.ok(!out.includes(token), out);
      assert.ok(!/bot\d{3,}:[A-Za-z0-9_-]{10,}/.test(out), out);
    }
    assert.equal(redactSecrets("nothing secret here"), "nothing secret here");
    for (const secret of [config.sessionSecret, config.webhookSecret, config.supabaseKey]) {
      assert.ok(!redactSecrets(`a ${secret} b`).includes(secret));
    }
  });

  Deno.test("describeError: causes are included but the token is not", () => {
    const url = `https://api.telegram.org/file/bot${config.botToken}/photos/a.png`;
    const error = new TypeError("fetch failed", {
      cause: new Error(`error sending request for url (${url}): client error (Connect)`),
    });
    const text = describeError(error);
    assert.ok(text.includes("error sending request for url"), "the useful part is kept");
    assert.ok(!text.includes(config.botToken));
  });

  Deno.test("handleError and logError never print the token", async () => {
    const real = console.error;
    const lines: string[] = [];
    try {
      console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
      const app = new Hono();
      app.onError(handleError);
      app.get("/boom", () => {
        throw new TypeError("fetch failed", {
          cause: new Error(`url (https://api.telegram.org/bot${config.botToken}/getFile)`),
        });
      });
      assert.equal((await app.request("/boom")).status, 500);
      logError("Bot error", {
        nested: { error: new Error(`https://api.telegram.org/bot${config.botToken}/sendMessage`) },
      });
      assert.ok(lines.length >= 2);
      assert.ok(!lines.join("\n").includes(config.botToken));
    } finally {
      console.error = real;
    }
  });

  Deno.test("image preview: a failing Telegram request is a 502 and the log has no token", async () => {
    const realFetch = globalThis.fetch;
    const real = console.error;
    const lines: string[] = [];
    try {
      console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
      client.from = () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: { telegram_file_id: "tg", file_size: 10, mime_type: "image/png", file_name: "a.png" },
                  error: null,
                }),
            }),
          }),
        }),
      });
      globalThis.fetch = ((input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input);
        return url.includes("/getFile")
          ? Promise.resolve(new Response(JSON.stringify({ result: { file_path: "photos/a.png" } })))
          : Promise.reject(
            new TypeError("fetch failed", { cause: new Error(`error sending request for url (${url})`) }),
          );
      }) as typeof fetch;
      const app = new Hono();
      app.onError(handleError);
      app.route("/", fileRoutes);
      const response = await app.request(`/files/${FILE}/preview`);
      assert.equal(response.status, 502);
      assert.ok(lines.some((line) => line.includes("Image preview")));
      assert.ok(!lines.join("\n").includes(config.botToken), "the token must not be logged");
    } finally {
      globalThis.fetch = realFetch;
      console.error = real;
      restore();
    }
  });

  // ================================================================ 4. size formatting

  Deno.test("formatSize: values that round up move to the next unit (backend and frontend agree)", () => {
    const cases: Array<[number, string]> = [
      [0, "0 B"],
      [1, "1 B"],
      [1023, "1023 B"],
      [1024, "1 KB"],
      [1536, "2 KB"],
      [1048575, "1.00 MB"],
      [1048576, "1.00 MB"],
      [1572864, "1.50 MB"],
      [1073741823, "1.00 GB"],
      [1073741824, "1.00 GB"],
      [5 * 1073741824, "5.00 GB"],
      [Number.NaN, "0 B"],
      [-5, "0 B"],
    ];
    for (const [bytes, expected] of cases) {
      assert.equal(formatSize(bytes), expected, `backend ${bytes}`);
      assert.equal(frontendFormatSize(bytes), expected, `frontend ${bytes}`);
    }
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let i = 0; i < 5000; i++) {
      const bytes = Math.floor(rnd() ** 4 * 2 ** 42);
      const text = formatSize(bytes);
      assert.equal(frontendFormatSize(bytes), text);
      assert.doesNotMatch(text, /^1024 KB$|^1024\.00 MB$/, `${bytes} -> ${text}`);
    }
  });

  // ================================================================ 2. uploads: choose the folder first, never leave a copy behind

  /** A database for storeIncoming. `folderLookup` decides what the "incoming folder" lookups answer. */
  function uploadDb(options: { insert: () => Promise<unknown>; settingFails?: boolean }) {
    client.from = (table: string) => {
      if (table === "settings") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve(
                  options.settingFails
                    ? { data: null, error: { message: "boom" } }
                    : { data: null, error: null },
                ),
            }),
          }),
        };
      }
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select: () => chain,
        match: () => chain,
        is: () => chain,
        eq: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        insert: () => ({ select: () => ({ single: options.insert }) }),
      };
      return chain;
    };
  }
  const message = (id: number) =>
    // deno-lint-ignore no-explicit-any
    ({
      message_id: id,
      chat: { id: 7 },
      date: 1,
      document: {
        file_id: "f",
        file_unique_id: "u" + id,
        file_name: "a.png",
        mime_type: "image/png",
        file_size: 10,
      },
    }) as any;

  async function withTelegram(run: (calls: { copies: number; deleted: number[] }) => Promise<void>) {
    const realCopy = bot.api.copyMessage;
    const realDelete = bot.api.deleteMessage;
    const calls = { copies: 0, deleted: [] as number[] };
    // deno-lint-ignore no-explicit-any
    const api = bot.api as any;
    api.copyMessage = () => (calls.copies++, Promise.resolve({ message_id: 900 + calls.copies }));
    api.deleteMessage = (_chat: number, id: number) => (calls.deleted.push(id), Promise.resolve(true));
    try {
      await run(calls);
    } finally {
      api.copyMessage = realCopy;
      api.deleteMessage = realDelete;
      restore();
    }
  }

  Deno.test("upload: if the destination folder cannot be looked up, nothing is copied", async () => {
    await withTelegram(async (calls) => {
      uploadDb({ insert: () => Promise.resolve({ data: { id: "x" }, error: null }), settingFails: true });
      await assert.rejects(() => storeIncoming(message(601)), /Unable to read settings/);
      assert.equal(calls.copies, 0, "no channel copy was made");
      assert.deepEqual(calls.deleted, []);
    });
  });

  Deno.test("upload: any failure after the copy removes the copy (insert error, thrown error, duplicate)", async () => {
    await withTelegram(async (calls) => {
      uploadDb({ insert: () => Promise.resolve({ data: null, error: { code: "XX000", message: "boom" } }) });
      await assert.rejects(() => storeIncoming(message(602)));
      assert.deepEqual(calls.deleted, [901]);

      uploadDb({ insert: () => Promise.reject(new Error("network down")) });
      await assert.rejects(() => storeIncoming(message(603)), /network down/);
      assert.deepEqual(calls.deleted, [901, 902]);

      uploadDb({
        insert: () => Promise.resolve({ data: null, error: { code: "23505", message: "duplicate" } }),
      });
      assert.deepEqual(await storeIncoming(message(604)), { status: "duplicate", inTrash: false });
      assert.deepEqual(calls.deleted, [901, 902, 903]);

      uploadDb({ insert: () => Promise.resolve({ data: { id: "new" }, error: null }) });
      const stored = await storeIncoming(message(605));
      assert.equal(stored.status, "stored");
      assert.deepEqual(calls.deleted, [901, 902, 903], "a successful upload keeps its copy");
    });
  });

  Deno.test("upload: a copy that cannot be deleted is queued for retry, not forgotten", async () => {
    const realCopy = bot.api.copyMessage;
    const realDelete = bot.api.deleteMessage;
    const queued: unknown[] = [];
    try {
      uploadDb({ insert: () => Promise.resolve({ data: null, error: { code: "XX000", message: "boom" } }) });
      const fromWithQueue = client.from;
      client.from = (table: string) =>
        table === "pending_message_deletions"
          ? { upsert: (row: unknown) => (queued.push(row), Promise.resolve({ error: null })) }
          : fromWithQueue(table);
      // deno-lint-ignore no-explicit-any
      const api = bot.api as any;
      api.copyMessage = () => Promise.resolve({ message_id: 777 });
      api.deleteMessage = () => Promise.reject({ description: "Bad Request: message can't be deleted" });
      await assert.rejects(() => storeIncoming(message(606)));
      assert.equal(queued.length, 1);
      assert.equal((queued[0] as { message_id: number }).message_id, 777);
    } finally {
      bot.api.copyMessage = realCopy;
      bot.api.deleteMessage = realDelete;
      restore();
    }
  });

  // ================================================================ share keys

  Deno.test("share links: a separate key lets SESSION_SECRET change; old links stay readable", async () => {
    const legacyKey = "legacy-session-secret-0123456789-abcdefghijklmnop"; // what links were encrypted with before SHARE_SECRET
    const shareKey = "dedicated-share-secret-0123456789-abcdefghijklmnop";
    const old = await encryptToken("token-made-long-ago", legacyKey);
    const fresh = await encryptToken("token-made-today", shareKey);
    // with SHARE_SECRET set, reads try it first and then the old key
    assert.equal(await decryptToken(old, [shareKey, legacyKey]), "token-made-long-ago");
    assert.equal(await decryptToken(fresh, [shareKey, legacyKey]), "token-made-today");
    // a different key cannot read either (this is what used to happen after rotating SESSION_SECRET)
    assert.equal(await decryptToken(old, ["a-completely-different-secret-0123456789-abcdef"]), null);
    assert.equal(await decryptToken(fresh, [legacyKey]), null);
    assert.equal(await decryptToken(null, [shareKey]), null);
    assert.equal(await decryptToken("not.valid", [shareKey]), null);
    // default keys: no SHARE_SECRET in the test environment, so the session secret is used (nothing changes by default)
    assert.equal(config.shareSecretIsSeparate, false);
    assert.equal(await decryptToken(await encryptToken("plain")), "plain");
  });

  // ================================================================ delete queue

  function queueStub(initial: Array<{ chat_id: number; message_id: number; attempts: number }>) {
    let rows = [...initial];
    const log = { deletedFromQueue: [] as number[], updates: [] as unknown[], telegram: [] as number[] };
    client.from = (table: string) => {
      if (table === "files") {
        // deno-lint-ignore no-explicit-any
        const chain: any = {
          select: () => chain,
          eq: () => chain,
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ count: 0, error: null }).then(resolve),
        };
        return chain;
      }
      return {
        select: () => ({
          lte: () => ({
            order: () => ({ limit: (n: number) => Promise.resolve({ data: rows.slice(0, n), error: null }) }),
          }),
        }),
        delete: () => ({
          match: (
            key: { message_id: number },
          ) => ((rows = rows.filter((r) => r.message_id !== key.message_id)),
            log.deletedFromQueue.push(key.message_id),
            Promise.resolve({ error: null })),
        }),
        update: (values: unknown) => ({
          match: (
            key: { message_id: number },
          ) => ((rows = rows.filter((r) => r.message_id !== key.message_id)),
            log.updates.push({ values, key }),
            Promise.resolve({ error: null })),
        }),
      };
    };
    return log;
  }

  Deno.test("drain: works through the whole queue; failures are rescheduled, not retried in a tight loop", async () => {
    const realDelete = bot.api.deleteMessage;
    try {
      const rows = Array.from({ length: 60 }, (_, i) => ({ chat_id: -100, message_id: i + 1, attempts: 1 }));
      const log = queueStub(rows);
      // deno-lint-ignore no-explicit-any
      (bot.api as any).deleteMessage = (
        _chat: number,
        id: number,
      ) => (log.telegram.push(id),
        id === 13
          ? Promise.reject({ description: "Bad Request: message can't be deleted" })
          : Promise.resolve(true));
      const result = await drainPendingDeletions(30_000);
      assert.deepEqual(result, { deleted: 59, gaveUp: 0 });
      assert.equal(log.telegram.length, 60, "every message was tried exactly once");
      assert.equal(log.updates.length, 1); // #13 was rescheduled for later
      assert.ok(
        new Date((log.updates[0] as { values: { next_try_at: string } }).values.next_try_at).getTime() >
          Date.now(),
      );
      assert.deepEqual(await retryPendingDeletions(), { deleted: 0, gaveUp: 0, processed: 0 }); // nothing is due any more
    } finally {
      bot.api.deleteMessage = realDelete;
      restore();
    }
  });

  Deno.test("drain: only one runs at a time", async () => {
    const realDelete = bot.api.deleteMessage;
    try {
      const log = queueStub([{ chat_id: -100, message_id: 1, attempts: 1 }, {
        chat_id: -100,
        message_id: 2,
        attempts: 1,
      }]);
      // deno-lint-ignore no-explicit-any
      (bot.api as any).deleteMessage = async (_chat: number, id: number) => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        log.telegram.push(id);
        return true;
      };
      const [first, second] = await Promise.all([drainPendingDeletions(), drainPendingDeletions()]);
      assert.equal(first.deleted + second.deleted, 2);
      assert.deepEqual(log.telegram.sort(), [1, 2]);
    } finally {
      bot.api.deleteMessage = realDelete;
      restore();
    }
  });

  Deno.test("Empty Trash and permanent file delete answer at once (Telegram is not waited for)", async () => {
    const realDelete = bot.api.deleteMessage;
    try {
      const log = queueStub([{ chat_id: -100, message_id: 5, attempts: 1 }]);
      // deno-lint-ignore no-explicit-any
      (bot.api as any).deleteMessage = async (_chat: number, id: number) => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        log.telegram.push(id);
        return true;
      };
      const fromQueue = client.from;
      client.from = (table: string) => {
        if (table === "trashed_folders") return { select: () => Promise.resolve({ count: 0, error: null }) };
        if (table === "files") {
          // deno-lint-ignore no-explicit-any
          const chain: any = {
            select: () => chain,
            eq: () => chain,
            maybeSingle: () =>
              Promise.resolve({
                data: { file_name: "a.png", status: "trashed", trash_entry_id: null },
                error: null,
              }),
            then: (resolve: (v: unknown) => unknown) =>
              Promise.resolve({ count: 0, error: null }).then(resolve),
          };
          return chain;
        }
        if (table === "activity_logs") return { insert: () => Promise.resolve({ error: null }) };
        return fromQueue(table);
      };
      client.rpc = () =>
        Promise.resolve({ data: [{ tg_chat_id: -100, tg_message_id: 5, orphaned: true }], error: null });
      const app = new Hono();
      app.onError(handleError);
      app.route("/", fileRoutes);
      for (
        const request of [
          () => app.request("/trash/empty", json("POST")),
          () => app.request(`/files/${FILE}/permanent`, json("DELETE")),
        ]
      ) {
        log.telegram.length = 0;
        const started = Date.now();
        const response = await request();
        assert.equal(response.status, 200);
        assert.ok(Date.now() - started < 150, "answered before the (slow) Telegram call could finish");
        assert.deepEqual(log.telegram, []);
        await new Promise((resolve) => setTimeout(resolve, 500)); // the background drain finishes
      }
    } finally {
      bot.api.deleteMessage = realDelete;
      restore();
    }
  });

  // ================================================================ logout, unlock, recent sign-in

  function sessionApp(claimsOverride: Record<string, unknown> = {}) {
    const app = new Hono();
    app.onError(handleError);
    app.use("*", async (c, next) => {
      // deno-lint-ignore no-explicit-any
      (c as any).set("session", {
        sub: config.ownerId,
        via: "telegram",
        iat: Date.now() - 1000,
        at: Date.now() - 1000,
        exp: Date.now() + 3_600_000,
        v: 1,
        jti: "a".repeat(32),
        ...claimsOverride,
      });
      await next();
    });
    app.route("/", privateAuth);
    return app;
  }

  Deno.test("logout: signs THIS session out on the server", async () => {
    try {
      const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
      client.rpc = (
        name: string,
        args: Record<string, unknown>,
      ) => (calls.push({ name, args }), Promise.resolve({ data: null, error: null }));
      const app = new Hono();
      app.onError(handleError);
      app.route("/api/auth", publicAuth);
      const token = await createSession(config.ownerId, 1, "telegram");
      const claims = (await verifySession(token))!;
      const logout = (headers: Record<string, string>) =>
        app.request("/api/auth/logout", { method: "POST", headers });

      const ok = await logout({ Authorization: `Bearer ${token}` });
      assert.deepEqual(await ok.json(), { ok: true, revoked: true });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].name, "revoke_session");
      assert.equal(calls[0].args.p_jti, claims.jti);
      assert.equal(calls[0].args.p_expires, new Date(claims.exp).toISOString());
      assert.match(ok.headers.get("Set-Cookie") ?? "", /Max-Age=0/); // the cookie is cleared too

      // the session cookie works as well as the header
      await logout({ Cookie: `drive_session=${encodeURIComponent(token)}` });
      assert.equal(calls.length, 2);

      // no valid session: nothing to revoke, still a clean answer
      calls.length = 0;
      assert.deepEqual(await (await logout({ Authorization: "Bearer garbage" })).json(), {
        ok: true,
        revoked: false,
      });
      assert.deepEqual(await (await logout({})).json(), { ok: true, revoked: false });
      assert.equal(calls.length, 0);

      // the database cannot record it: the browser is still signed out, and the answer says it was not confirmed
      client.rpc = () => Promise.resolve({ data: null, error: { message: "boom" } });
      const unconfirmed = await logout({ Authorization: `Bearer ${token}` });
      assert.equal(unconfirmed.status, 200);
      assert.deepEqual(await unconfirmed.json(), { ok: true, revoked: false });
      assert.match(unconfirmed.headers.get("Set-Cookie") ?? "", /Max-Age=0/);
    } finally {
      restore();
    }
  });

  Deno.test("/me: says exactly when the recent-sign-in window ends", async () => {
    const at = Date.now() - 120_000;
    try {
      client.from = () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: { password_enabled: true, login_username: "owner" }, error: null }),
          }),
        }),
      });
      const me = async (app: Hono) =>
        await (await app.request("/me")).json() as {
          recent_sign_in: boolean;
          recent_sign_in_until: number | null;
          can_change_without_current_password: boolean;
        };
      const fresh = await me(sessionApp({ at }));
      assert.equal(fresh.recent_sign_in_until, at + RECENT_SIGNIN_MS);
      assert.equal(fresh.recent_sign_in, true);
      const old = await me(sessionApp({ at: Date.now() - 3 * RECENT_SIGNIN_MS }));
      assert.equal(old.recent_sign_in, false);
      assert.ok(
        old.recent_sign_in_until! < Date.now(),
        "the app can see the window has passed without asking again",
      );
      const password = await me(sessionApp({ via: "password", at: undefined }));
      assert.equal(password.recent_sign_in_until, null);
    } finally {
      restore();
    }
  });

  Deno.test("changing credentials without the current password says so (and does not count an attempt)", async () => {
    try {
      const rpcCalls: string[] = [];
      client.rpc = (name: string) => (rpcCalls.push(name), Promise.resolve({ data: true, error: null }));
      client.from = () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({
                data: {
                  password_enabled: true,
                  login_username: "owner",
                  password_hash: "h",
                  password_salt: "s",
                  password_iterations: 600000,
                },
                error: null,
              }),
          }),
        }),
      });
      const app = sessionApp({ at: Date.now() - 3 * RECENT_SIGNIN_MS });
      for (
        const body of [{ username: "owner", password: "brand-new-password-9" }, {
          username: "owner",
          password: "brand-new-password-9",
          current_password: "",
        }]
      ) {
        const response = await app.request("/password", json("PATCH", body));
        assert.equal(response.status, 403);
        assert.equal(
          (await response.json() as { error: string }).error,
          "Enter your current password to continue.",
        );
      }
      assert.deepEqual(rpcCalls, [], "no sign-in attempt was counted");
    } finally {
      restore();
    }
  });

  Deno.test("unlock sign-in: a recent Telegram launch clears the lockout, an old one cannot", async () => {
    try {
      const deleted: unknown[] = [];
      client.from = (table: string) =>
        table === "login_attempts"
          ? {
            delete: (options: unknown) => ({
              neq: (
                column: string,
                value: string,
              ) => (deleted.push({ options, column, value }), Promise.resolve({ count: 3, error: null })),
            }),
          }
          : { insert: () => Promise.resolve({ error: null }) };
      const stale = await sessionApp({ at: Date.now() - 3 * RECENT_SIGNIN_MS }).request(
        "/unlock-signin",
        json("POST"),
      );
      assert.equal(stale.status, 403);
      assert.equal(deleted.length, 0);
      const passwordSession = await sessionApp({ via: "password", at: undefined }).request(
        "/unlock-signin",
        json("POST"),
      );
      assert.equal(passwordSession.status, 403); // someone who is locked out by password cannot unlock themselves with a password
      const ok = await sessionApp().request("/unlock-signin", json("POST"));
      assert.deepEqual(await ok.json(), { ok: true, cleared: 3 });
      assert.equal(deleted.length, 1);
    } finally {
      restore();
    }
  });
}

// ======================================================================
// batch8 (was batch8_test.ts)
// ======================================================================
{
  Deno.env.set("BOT_USERNAME", "ci_bot");
  const { db } = await import("./db.ts");
  const { handleError } = await import("./http.ts");
  const { shareRoutes } = await import("./routes/shares.ts");
  const { folderRoutes } = await import("./routes/folders.ts");
  const { encryptToken } = await import("./security.ts");

  // deno-lint-ignore no-explicit-any
  const client = db as any;
  const realFrom = client.from;
  const realRpc = client.rpc;
  const restore = () => {
    client.from = realFrom;
    client.rpc = realRpc;
  };
  const FILE = "22222222-2222-4222-8222-2222222222f1";
  const FOLDER = "33333333-3333-4333-8333-3333333333a1";
  const down = { data: null, error: { message: "database unreachable" } };
  const json = (method: string, body?: unknown) => ({
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // deno-lint-ignore no-explicit-any
  const appWith = (routes: Hono<any>) => {
    const app = new Hono();
    app.onError(handleError);
    app.route("/", routes);
    return app;
  };
  const errorOf = async (response: Response) => (await response.json() as { error: string }).error;

  // ============================================================ share links

  interface ShareDb {
    file?: unknown;
    shareLookup?: unknown[]; // answers for successive lookups of the file's link
    removeAnswer?: unknown;
    insertAnswer?: unknown;
  }
  function shareDb(options: ShareDb) {
    const log = { inserts: 0, removes: 0, lookups: 0 };
    client.from = (table: string) => {
      if (table === "files") {
        return {
          select: () => ({
            eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(options.file) }) }),
          }),
        };
      }
      if (table === "shares") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: () =>
                    Promise.resolve(
                      (options.shareLookup ?? [{ data: null, error: null }])[
                        Math.min(log.lookups++, (options.shareLookup ?? [1]).length - 1)
                      ],
                    ),
                }),
              }),
            }),
          }),
          delete: () => ({
            eq: () => (log.removes++, Promise.resolve(options.removeAnswer ?? { error: null })),
          }),
          insert: () => (log.inserts++, {
            select: () => ({
              single: () =>
                Promise.resolve(
                  options.insertAnswer ??
                    { data: { id: "s1", file_id: FILE, created_at: "2026-01-01T00:00:00Z" }, error: null },
                ),
            }),
          }),
        };
      }
      return { insert: () => Promise.resolve({ error: null }) };
    };
    return log;
  }
  const FOUND = { data: { id: FILE, file_name: "a.png" }, error: null };
  const share = (app: Hono) => app.request(`/files/${FILE}/share`, json("POST"));

  Deno.test("create share link: a database failure is 503, a really missing file is still 404", async () => {
    try {
      const app = appWith(shareRoutes);
      const log = shareDb({ file: down });
      const outage = await share(app);
      assert.equal(outage.status, 503);
      assert.equal(outage.headers.get("Retry-After"), "5");
      assert.notEqual(await errorOf(outage), "File not found");
      assert.equal(log.inserts, 0);

      shareDb({ file: { data: null, error: null } });
      const missing = await share(app);
      assert.equal(missing.status, 404);
      assert.equal(await errorOf(missing), "File not found");
    } finally {
      restore();
    }
  });

  Deno.test("create share link: a failed link lookup never leads to a second link being created", async () => {
    try {
      const app = appWith(shareRoutes);
      const log = shareDb({ file: FOUND, shareLookup: [down] });
      assert.equal((await share(app)).status, 503);
      assert.equal(log.inserts, 0, "nothing was created while the state of the link was unknown");
    } finally {
      restore();
    }
  });

  Deno.test("create share link: an unreadable old link is replaced, and a failure to remove it stops cleanly", async () => {
    try {
      const app = appWith(shareRoutes);
      const unreadable = {
        data: { id: "old", share_token_enc: "not.readable", created_at: "2025-01-01T00:00:00Z" },
        error: null,
      };

      let log = shareDb({
        file: FOUND,
        shareLookup: [unreadable],
        removeAnswer: { error: { message: "boom" } },
      });
      assert.equal((await share(app)).status, 503);
      assert.equal(log.removes, 1);
      assert.equal(log.inserts, 0);

      log = shareDb({ file: FOUND, shareLookup: [unreadable] }); // removal works: the usual replacement
      const created = await share(app);
      assert.equal(created.status, 201);
      assert.deepEqual([log.removes, log.inserts], [1, 1]);
    } finally {
      restore();
    }
  });

  Deno.test("create share link: losing a race whose follow-up lookup fails is 503; the normal paths are unchanged", async () => {
    try {
      const app = appWith(shareRoutes);
      shareDb({
        file: FOUND,
        shareLookup: [{ data: null, error: null }, down],
        insertAnswer: { data: null, error: { code: "23505", message: "duplicate" } },
      });
      assert.equal((await share(app)).status, 503);

      // another request created the link first and we can read it: reuse it
      const winner = {
        data: {
          id: "w1",
          share_token_enc: await encryptToken("winner-token"),
          created_at: "2026-01-01T00:00:00Z",
        },
        error: null,
      };
      shareDb({
        file: FOUND,
        shareLookup: [{ data: null, error: null }, winner],
        insertAnswer: { data: null, error: { code: "23505", message: "duplicate" } },
      });
      const reused = await share(app);
      assert.equal(reused.status, 200);
      assert.equal(
        (await reused.json() as { url: string }).url,
        "https://t.me/ci_bot?start=share_winner-token",
      );

      // an existing, readable link is returned as it is (nothing created or removed)
      const log = shareDb({ file: FOUND, shareLookup: [winner] });
      const existing = await share(app);
      assert.equal(existing.status, 200);
      assert.deepEqual([log.inserts, log.removes], [0, 0]);

      // a file without a link gets one
      const fresh = shareDb({ file: FOUND });
      assert.equal((await share(app)).status, 201);
      assert.equal(fresh.inserts, 1);

      // any other failure to create is still a plain 500 (unchanged)
      shareDb({ file: FOUND, insertAnswer: { data: null, error: { code: "23503", message: "fk" } } });
      assert.equal((await share(app)).status, 500);
    } finally {
      restore();
    }
  });

  // ============================================================ folders

  function folderDb(options: { lookup?: unknown; create?: unknown; update?: unknown; rpc?: unknown }) {
    const log = { rpcCalls: 0 };
    client.from = (table: string) =>
      table === "folders"
        ? {
          select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(options.lookup) }) }),
          insert: () => ({ select: () => ({ single: () => Promise.resolve(options.create) }) }),
          update: () => ({
            eq: () => ({ select: () => ({ maybeSingle: () => Promise.resolve(options.update) }) }),
          }),
        }
        : { insert: () => Promise.resolve({ error: null }) };
    client.rpc =
      () => (log.rpcCalls++,
        Promise.resolve(options.rpc ?? { data: [{ o_entry: "e1", o_files: 2, o_folders: 1 }], error: null }));
    return log;
  }

  Deno.test("delete folder: a database failure is 503 (and nothing is deleted), a missing folder is 404", async () => {
    try {
      const app = appWith(folderRoutes);
      let log = folderDb({ lookup: down });
      const outage = await app.request(`/folders/${FOLDER}`, json("DELETE"));
      assert.equal(outage.status, 503);
      assert.equal(outage.headers.get("Retry-After"), "5");
      assert.notEqual(await errorOf(outage), "Folder not found");
      assert.equal(log.rpcCalls, 0);

      log = folderDb({ lookup: { data: null, error: null } });
      const missing = await app.request(`/folders/${FOLDER}`, json("DELETE"));
      assert.equal(missing.status, 404);
      assert.equal(await errorOf(missing), "Folder not found");
      assert.equal(log.rpcCalls, 0);

      log = folderDb({ lookup: { data: { name: "k" }, error: null } });
      const ok = await app.request(`/folders/${FOLDER}`, json("DELETE"));
      assert.equal(ok.status, 200);
      assert.deepEqual(await ok.json(), { ok: true, trash_id: "e1", trashed_files: 2, trashed_folders: 1 });
      assert.equal(log.rpcCalls, 1);
    } finally {
      restore();
    }
  });

  /** What each kind of database error should become for the person using the app. */
  const ERROR_TABLE: Array<[string, string | undefined, number]> = [
    ["duplicate name", "23505", 409],
    ["name too long (check constraint)", "23514", 400],
    ["parent folder missing (foreign key)", "23503", 400],
    ["text too long (data exception)", "22001", 400],
    ["invalid value (data exception)", "22P02", 400],
    ["network failure (no code)", "", 503],
    ["no code at all", undefined, 503],
    ["API gateway problem", "PGRST301", 503],
    ["connection failure", "08006", 503],
    ["permission problem", "42501", 503],
  ];

  Deno.test("create folder: request mistakes are 409/400, a database problem is 503 (it used to be 400)", async () => {
    try {
      const app = appWith(folderRoutes);
      for (const [label, code, status] of ERROR_TABLE) {
        folderDb({ create: { data: null, error: { code, message: label } } });
        const response = await app.request("/folders", json("POST", { name: "Photos" }));
        assert.equal(response.status, status, label);
        if (status === 409) assert.match(await errorOf(response), /already exists/);
        if (status === 400) assert.equal(await errorOf(response), "Unable to create folder");
      }
      folderDb({ create: { data: { id: FOLDER, name: "Photos" }, error: null } });
      assert.equal((await app.request("/folders", json("POST", { name: "Photos" }))).status, 201);
      // plain input mistakes are answered before the database is asked (unchanged)
      assert.equal((await app.request("/folders", json("POST", { name: "" }))).status, 400);
      assert.equal((await app.request("/folders", json("POST", { name: "x".repeat(101) }))).status, 400);
    } finally {
      restore();
    }
  });

  Deno.test("rename folder: same mapping, and a really missing folder is still 404", async () => {
    try {
      const app = appWith(folderRoutes);
      for (const [label, code, status] of ERROR_TABLE) {
        folderDb({ update: { data: null, error: { code, message: label } } });
        const response = await app.request(`/folders/${FOLDER}`, json("PATCH", { name: "New" }));
        assert.equal(response.status, status, label);
        if (status === 400) assert.equal(await errorOf(response), "Unable to update folder");
      }
      folderDb({ update: { data: null, error: null } });
      const missing = await app.request(`/folders/${FOLDER}`, json("PATCH", { name: "New" }));
      assert.equal(missing.status, 404);
      folderDb({ update: { data: { id: FOLDER, name: "New" }, error: null } });
      assert.equal((await app.request(`/folders/${FOLDER}`, json("PATCH", { name: "New" }))).status, 200);
      assert.equal((await app.request(`/folders/${FOLDER}`, json("PATCH", {}))).status, 400); // "No changes supplied" (unchanged)
    } finally {
      restore();
    }
  });
}

// ======================================================================
// review fixes (was review_fixes_test.ts)
// ======================================================================
{
  Deno.env.set("BOT_USERNAME", "ci_bot");
  const { db } = await import("./db.ts");
  const { originGuard } = await import("./routes/auth.ts");
  const { systemRoutes } = await import("./routes/system.ts");
  const { folderRoutes } = await import("./routes/folders.ts");
  const { shareRoutes } = await import("./routes/shares.ts");
  const { fileRoutes } = await import("./routes/files.ts");
  const { encryptToken } = await import("./security.ts");
  const { handleError, ServiceUnavailableError } = await import("./http.ts");
  const { publicAuth, privateAuth } = await import("./routes/auth.ts");

  // deno-lint-ignore no-explicit-any
  const client = db as any;
  const realFrom = client.from;
  const realRpc = client.rpc;
  const restore = () => {
    client.from = realFrom;
    client.rpc = realRpc;
  };

  const ALLOWED = "https://drive.example.test";
  const A = "11111111-1111-4111-8111-11111111111a";
  const B = "11111111-1111-4111-8111-11111111111b";
  const OTHER = "11111111-1111-4111-8111-11111111111d";
  const FILE = "22222222-2222-4222-8222-2222222222f1";

  // ---------------------------------------------------------------- origin guard

  Deno.test("originGuard: state-changing requests need an allowed Origin", async () => {
    const app = new Hono();
    app.use("*", originGuard);
    app.all("/x", (c) => c.text("ok"));
    const send = (method: string, headers: Record<string, string> = {}) =>
      app.request("/x", { method, headers });

    assert.equal((await send("GET")).status, 200); // reads without Origin stay allowed
    assert.equal((await send("GET", { Origin: "https://evil.example" })).status, 403);
    assert.equal((await send("POST", { Origin: ALLOWED })).status, 200);
    assert.equal((await send("DELETE", { Origin: ALLOWED })).status, 200);
    assert.equal((await send("POST", { Origin: "https://evil.example" })).status, 403);
    assert.equal((await send("POST", { Origin: "null" })).status, 403);
    assert.equal((await send("POST")).status, 403); // no Origin at all
    assert.equal((await send("PATCH")).status, 403);
    assert.equal((await send("POST", { "Sec-Fetch-Site": "cross-site" })).status, 403);
    assert.equal((await send("POST", { "Sec-Fetch-Site": "same-origin" })).status, 200); // browser vouches for it
  });

  // -------------------------------------------------------------------- settings

  Deno.test("settings: inherited property names are not settings", async () => {
    const upserts: unknown[] = [];
    try {
      client.from = () => ({
        upsert: (rows: unknown) => {
          upserts.push(rows);
          return Promise.resolve({ error: null });
        },
        select: () => Promise.resolve({ data: [], error: null }),
        insert: () => Promise.resolve({ error: null }),
      });
      const app = new Hono();
      app.route("/", systemRoutes);
      const patch = (body: string) =>
        app.request("/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body });

      for (
        const body of [
          '{"constructor":"x"}',
          '{"toString":"x"}',
          '{"__proto__":{"theme":"dark"}}',
          '{"hasOwnProperty":1}',
        ]
      ) {
        const response = await patch(body);
        assert.equal(response.status, 400, body);
      }
      assert.equal(upserts.length, 0);

      const ok = await patch('{"theme":"dark","constructor":"x"}');
      assert.equal(ok.status, 200);
      assert.deepEqual((upserts[0] as { key: string }[]).map((row) => row.key), ["theme"]);
    } finally {
      restore();
    }
  });

  // ------------------------------------------------------------------ folder copy

  const foldersStub = (rows: unknown[]) => ({
    select: () => ({
      order: () => ({ order: () => ({ range: () => Promise.resolve({ data: rows, error: null }) }) }),
    }),
    insert: () => Promise.resolve({ error: null }),
  });

  Deno.test("folder copy: refuses a destination inside the source tree, allows others", async () => {
    const calls: unknown[] = [];
    try {
      client.from = () =>
        foldersStub([
          { id: A, parent_id: null },
          { id: B, parent_id: A },
          { id: OTHER, parent_id: null },
        ]);
      client.rpc = (name: string, args: unknown) => {
        calls.push({ name, args });
        return Promise.resolve({ data: "new-folder-id", error: null });
      };
      const app = new Hono();
      app.route("/", folderRoutes);
      const copy = (body: unknown) =>
        app.request(`/folders/${A}/copy`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

      assert.equal((await copy({ parent_id: A })).status, 400); // into itself
      assert.equal((await copy({ parent_id: B })).status, 400); // into a descendant
      assert.equal(calls.length, 0);
      assert.equal((await copy({ parent_id: OTHER })).status, 201);
      assert.equal((await copy({})).status, 201); // to the top level
      assert.equal(calls.length, 2);

      // The database enforces the same rule on its own (error 22023 from copy_folder).
      client.rpc = () =>
        Promise.resolve({ data: null, error: { code: "22023", message: "invalid_destination" } });
      assert.equal((await copy({ parent_id: OTHER })).status, 400);
    } finally {
      restore();
    }
  });

  // ------------------------------------------------------------------ share links

  Deno.test("share link: a concurrent request that loses the race reuses the winner's link", async () => {
    const winnerRow = {
      id: "share-1",
      share_token_enc: await encryptToken("winner-token"),
      created_at: "2026-01-01T00:00:00Z",
    };
    let shareLookups = 0;
    try {
      client.from = (table: string) => {
        if (table === "files") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () => Promise.resolve({ data: { id: FILE, file_name: "a.png" } }),
                }),
              }),
            }),
          };
        }
        if (table === "shares") {
          return {
            select: () => ({
              eq: () => ({
                order: () => ({
                  limit: () => ({
                    // first look: nothing yet; after the insert collided: the other request's link
                    maybeSingle: () => Promise.resolve({ data: shareLookups++ === 0 ? null : winnerRow }),
                  }),
                }),
              }),
            }),
            insert: () => ({
              select: () => ({
                single: () =>
                  Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key" } }),
              }),
            }),
          };
        }
        return { insert: () => Promise.resolve({ error: null }) };
      };
      const app = new Hono();
      app.route("/", shareRoutes);
      const response = await app.request(`/files/${FILE}/share`, { method: "POST" });
      assert.equal(response.status, 200);
      const body = await response.json() as { id: string; url: string };
      assert.equal(body.id, "share-1");
      assert.equal(body.url, "https://t.me/ci_bot?start=share_winner-token");
    } finally {
      restore();
    }
  });

  // -------------------------------------------------------------------- previews

  Deno.test("preview: SVG and other non-raster types are refused; PNG is served sandboxed", async () => {
    const realFetch = globalThis.fetch;
    const fileRow = (mime: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({
                data: { telegram_file_id: "tg", file_size: 100, mime_type: mime, file_name: "a" },
              }),
          }),
        }),
      }),
    });
    try {
      const app = new Hono();
      app.route("/", fileRoutes);
      for (const mime of ["image/svg+xml", "image/svg+xml; charset=utf-8", "text/html", "image/x-icon"]) {
        client.from = () => fileRow(mime);
        assert.equal((await app.request(`/files/${FILE}/preview`)).status, 415, mime);
      }

      client.from = () => fileRow("image/png");
      globalThis.fetch = ((input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input);
        return Promise.resolve(
          url.includes("/getFile")
            ? new Response(JSON.stringify({ result: { file_path: "photos/a.png" } }))
            : new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Length": "4" } }),
        );
      }) as typeof fetch;
      const response = await app.request(`/files/${FILE}/preview`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("Content-Type"), "image/png");
      assert.equal(response.headers.get("Content-Security-Policy"), "default-src 'none'; sandbox");
      assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
      await response.arrayBuffer();
    } finally {
      globalThis.fetch = realFetch;
      restore();
    }
  });

  // --------------------------------------------------------------- folder delete

  Deno.test("folder delete: reports how many files went to Trash and logs it", async () => {
    const logged: unknown[] = [];
    try {
      client.from = (table: string) =>
        table === "folders"
          ? {
            select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { name: "k" } }) }) }),
          }
          : { insert: (row: unknown) => (logged.push(row), Promise.resolve({ error: null })) };
      let called: unknown;
      client.rpc = (name: string, args: unknown) => {
        called = { name, args };
        return Promise.resolve({
          data: [{ o_entry: "trash-item-1", o_files: 3, o_folders: 2 }],
          error: null,
        });
      };
      const app = new Hono();
      app.route("/", folderRoutes);
      const response = await app.request(`/folders/${A}`, { method: "DELETE" });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        ok: true,
        trash_id: "trash-item-1",
        trashed_files: 3,
        trashed_folders: 2,
      });
      assert.deepEqual(called, { name: "delete_folder", args: { p_id: A } });
      assert.deepEqual((logged[0] as { details: unknown }).details, {
        name: "k",
        trashed_files: 3,
        trashed_folders: 2,
      });

      client.rpc = () => Promise.resolve({ data: null, error: { code: "XX000", message: "boom" } });
      assert.equal((await app.request(`/folders/${A}`, { method: "DELETE" })).status, 500);
      assert.equal((await app.request(`/folders/not-a-uuid`, { method: "DELETE" })).status, 400);
    } finally {
      restore();
    }
  });

  // ------------------------------------------------------------------ Trash routes

  const trashApp = () => {
    const app = new Hono();
    app.route("/", fileRoutes);
    return app;
  };
  const ENTRY = "33333333-3333-4333-8333-333333333333";
  const jsonPost = (path: string, body?: unknown) =>
    trashApp().request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  /** A Trash database with `folderTotal` deleted folders and `fileTotal` loose trashed files; records every query. */
  const trashDb = (folderTotal: number, fileTotal: number, calls: string[]) => (table: string) => {
    const rows = (prefix: string, from: number, to: number) =>
      Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => ({ id: `${prefix}${from + index}` }));
    if (table === "trashed_folders") {
      return {
        select: (_columns: string, options?: { head?: boolean }) =>
          options?.head ? Promise.resolve({ count: folderTotal, error: null }) : {
            order: () => ({
              order: () => ({
                range: (from: number, to: number) => {
                  calls.push(`folders ${from}-${to}`);
                  return Promise.resolve({
                    data: rows("folder-", from, Math.min(to, folderTotal - 1)),
                    error: null,
                  });
                },
              }),
            }),
          },
      };
    }
    return {
      select: () => {
        const filters: string[] = [];
        // deno-lint-ignore no-explicit-any
        const builder: any = {
          eq: (column: string, value: string) => (filters.push(`${column}=${value}`), builder),
          is: (column: string) => (filters.push(`${column} is null`), builder),
          order: () => builder,
          range: (from: number, to: number) => {
            calls.push(`files ${from}-${to} [${filters.join(",")}]`);
            // like a real database: only rows that exist come back
            return Promise.resolve({
              data: rows("file-", from, Math.min(to, fileTotal - 1)),
              count: fileTotal,
              error: null,
            });
          },
          then: (resolve: (value: unknown) => unknown) => {
            calls.push("files count");
            return Promise.resolve({ data: null, count: fileTotal, error: null }).then(resolve);
          },
        };
        return builder;
      },
    };
  };

  type TrashBody = {
    items: { id: string }[];
    folders: { id: string }[];
    folder_total: number;
    has_more: boolean;
  };

  Deno.test("Trash list: folders and files are paged as one list, nothing is cut off", async () => {
    try {
      const calls: string[] = [];
      client.from = trashDb(3, 5, calls);
      const get = async (page: number, limit: number) =>
        await (await trashApp().request(`/trash?page=${page}&limit=${limit}`)).json() as TrashBody;

      const first = await get(1, 2);
      assert.deepEqual(first.folders.map((row) => row.id), ["folder-0", "folder-1"]);
      assert.equal(first.items.length, 0);
      assert.equal(first.has_more, true);
      const second = await get(2, 2); // the last folder, then the first file
      assert.deepEqual(second.folders.map((row) => row.id), ["folder-2"]);
      assert.deepEqual(second.items.map((row) => row.id), ["file-0"]);
      const third = await get(3, 2);
      assert.deepEqual(third.items.map((row) => row.id), ["file-1", "file-2"]);
      const fourth = await get(4, 2);
      assert.deepEqual(fourth.items.map((row) => row.id), ["file-3", "file-4"]);
      assert.equal(fourth.has_more, false);
      assert.equal(fourth.folder_total, 3);
      // files inside deleted folders are never listed on their own
      assert.ok(
        calls.filter((call) => call.startsWith("files ") && call !== "files count").every((call) =>
          call.endsWith("[status=trashed,trash_entry_id is null]")
        ),
      );
    } finally {
      restore();
    }
  });

  Deno.test("Trash list: 450 deleted folders are all reachable (the old 200-folder cap is gone)", async () => {
    try {
      client.from = trashDb(450, 30, []);
      const folders: string[] = [];
      const files: string[] = [];
      let hasMore = true;
      for (let page = 1; hasMore; page++) {
        const body = await (await trashApp().request(`/trash?page=${page}&limit=100`)).json() as TrashBody;
        folders.push(...body.folders.map((row) => row.id));
        files.push(...body.items.map((row) => row.id));
        hasMore = body.has_more;
        assert.ok(page < 20, "paging must end");
      }
      assert.equal(folders.length, 450);
      assert.equal(new Set(folders).size, 450); // no duplicates
      assert.equal(files.length, 30);
      assert.equal(new Set(files).size, 30);
    } finally {
      restore();
    }
  });

  Deno.test("restore folder: reports what came back, handles rename, root fallback and errors", async () => {
    try {
      client.from = () => ({ insert: () => Promise.resolve({ error: null }) });
      const row = { o_folder: A, o_name: "k", o_files: 1, o_folders: 2, o_renamed: false, o_to_root: false };
      client.rpc = (name: string, args: unknown) => {
        assert.equal(name, "restore_folder");
        assert.deepEqual(args, { p_entry: ENTRY });
        return Promise.resolve({ data: [row], error: null });
      };
      const ok = await jsonPost(`/trash/folders/${ENTRY}/restore`);
      assert.equal(ok.status, 200);
      assert.deepEqual(await ok.json(), {
        ok: true,
        folder_id: A,
        name: "k",
        restored_files: 1,
        restored_folders: 2,
        renamed: false,
        moved_to_root: false,
      });

      client.rpc = () =>
        Promise.resolve({
          data: [{ ...row, o_name: "k (restored)", o_renamed: true, o_to_root: true }],
          error: null,
        });
      const moved = await (await jsonPost(`/trash/folders/${ENTRY}/restore`)).json() as Record<
        string,
        unknown
      >;
      assert.equal(moved.renamed, true);
      assert.equal(moved.moved_to_root, true);
      assert.equal(moved.name, "k (restored)");

      client.rpc = () =>
        Promise.resolve({ data: null, error: { code: "P0002", message: "trash_entry_not_found" } });
      assert.equal((await jsonPost(`/trash/folders/${ENTRY}/restore`)).status, 404);
      client.rpc = () => Promise.resolve({ data: null, error: { code: "23505", message: "duplicate" } });
      assert.equal((await jsonPost(`/trash/folders/${ENTRY}/restore`)).status, 409);
      client.rpc = () => Promise.resolve({ data: null, error: { code: "XX000", message: "boom" } });
      assert.equal((await jsonPost(`/trash/folders/${ENTRY}/restore`)).status, 500);
      assert.equal((await jsonPost(`/trash/folders/not-a-uuid/restore`)).status, 400);
    } finally {
      restore();
    }
  });

  Deno.test("restore file: goes back through the database (original folder), flags the top-level fallback", async () => {
    try {
      client.from = () => ({ insert: () => Promise.resolve({ error: null }) });
      client.rpc = (name: string, args: unknown) => {
        assert.equal(name, "restore_files");
        assert.deepEqual(args, { p_ids: [FILE] });
        return Promise.resolve({ data: [{ o_id: FILE, o_name: "1.png", o_to_root: false }], error: null });
      };
      const ok = await jsonPost(`/trash/${FILE}/restore`);
      assert.deepEqual(await ok.json(), { ok: true, moved_to_root: false });

      client.rpc = () =>
        Promise.resolve({ data: [{ o_id: FILE, o_name: "1.png", o_to_root: true }], error: null });
      assert.deepEqual(await (await jsonPost(`/trash/${FILE}/restore`)).json(), {
        ok: true,
        moved_to_root: true,
      });

      client.rpc = () => Promise.resolve({ data: [], error: null }); // not trashed, or inside a deleted folder
      assert.equal((await jsonPost(`/trash/${FILE}/restore`)).status, 404);

      client.rpc = () =>
        Promise.resolve({ data: [{ o_id: FILE, o_name: "1.png", o_to_root: true }], error: null });
      const batch = await (await jsonPost("/files/batch/restore", { file_ids: [FILE] })).json() as Record<
        string,
        unknown
      >;
      assert.deepEqual(batch, { ok: true, count: 1, moved_to_root: 1 });
    } finally {
      restore();
    }
  });

  Deno.test("permanent delete of a Trash folder answers at once; queued channel messages are deleted in the background", async () => {
    const { bot } = await import("./telegram.ts");
    const realDelete = bot.api.deleteMessage;
    const deleted: number[] = [];
    const removedFromQueue: unknown[] = [];
    try {
      // The database queued the orphaned message (11) in the same step as the purge; 12 is still used by a copy.
      let queue = [{ chat_id: -100, message_id: 11, attempts: 1 }];
      client.from = (table: string) => {
        if (table === "trashed_folders") {
          return {
            select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { name: "k" } }) }) }),
          };
        }
        if (table === "pending_message_deletions") {
          return {
            select: () => ({
              lte: () => ({ order: () => ({ limit: () => Promise.resolve({ data: queue, error: null }) }) }),
            }),
            delete: () => ({
              match: (
                key: unknown,
              ) => (removedFromQueue.push(key), (queue = []), Promise.resolve({ error: null })),
            }),
          };
        }
        if (table === "files") {
          // deno-lint-ignore no-explicit-any
          const chain: any = {
            select: () => chain,
            eq: () => chain,
            then: (resolve: (value: unknown) => unknown) =>
              Promise.resolve({ count: 0, error: null }).then(resolve),
          };
          return chain;
        }
        return { insert: () => Promise.resolve({ error: null }) };
      };
      client.rpc = (name: string, args: unknown) => {
        assert.equal(name, "purge_trashed_folder");
        assert.deepEqual(args, { p_entry: ENTRY });
        return Promise.resolve({
          data: [
            { tg_chat_id: -100, tg_message_id: 11, orphaned: true },
            { tg_chat_id: -100, tg_message_id: 12, orphaned: false },
          ],
          error: null,
        });
      };
      // Telegram is slow (like its 20-per-minute limit): the request must not wait for it.
      // deno-lint-ignore no-explicit-any
      (bot.api as any).deleteMessage = async (_chat: number, message: number) => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        deleted.push(message);
        return true;
      };
      const response = await trashApp().request(`/trash/folders/${ENTRY}`, { method: "DELETE" });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true, deleted_files: 2 });
      assert.deepEqual(deleted, [], "the answer came back before Telegram was asked");
      await new Promise((resolve) => setTimeout(resolve, 600));
      assert.deepEqual(deleted, [11]); // 12 is still used by a copy elsewhere, so it was never queued or deleted
      assert.equal(removedFromQueue.length, 1);

      client.from = () => ({
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }) }),
      });
      assert.equal((await trashApp().request(`/trash/folders/${ENTRY}`, { method: "DELETE" })).status, 404);
      assert.equal((await trashApp().request(`/trash/folders/x`, { method: "DELETE" })).status, 400);
    } finally {
      bot.api.deleteMessage = realDelete;
      restore();
    }
  });

  Deno.test("a file inside a deleted folder cannot be deleted on its own", async () => {
    try {
      client.from = () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: { file_name: "1.png", status: "trashed", trash_entry_id: ENTRY } }),
          }),
        }),
      });
      const response = await trashApp().request(`/files/${FILE}/permanent`, { method: "DELETE" });
      assert.equal(response.status, 409);
      assert.match((await response.json() as { error: string }).error, /deleted folder/);
    } finally {
      restore();
    }
  });

  // ------------------------------------------------------------ owner lookup failures

  Deno.test("handleError: unavailable dependencies are 503 with Retry-After, everything else 500", async () => {
    const app = new Hono();
    app.onError(handleError);
    app.get("/down", () => {
      throw new ServiceUnavailableError("db down");
    });
    app.get("/bug", () => {
      throw new Error("bug");
    });
    const down = await app.request("/down");
    assert.equal(down.status, 503);
    assert.equal(down.headers.get("Retry-After"), "5");
    assert.equal((await app.request("/bug")).status, 500);
  });

  Deno.test("owner lookup: a database failure is a 503, never 'wrong password' or 'password sign-in disabled'", async () => {
    const rpcCalls: string[] = [];
    try {
      const usersFail = {
        select: () => ({
          eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: "boom" } }) }),
        }),
      };
      client.from = (table: string) =>
        table === "users"
          ? usersFail
          : { select: () => ({ in: () => ({ gt: () => Promise.resolve({ data: [], error: null }) }) }) };
      client.rpc = (
        name: string,
      ) => (rpcCalls.push(name),
        Promise.resolve({ data: name === "reserve_login_attempt" ? true : null, error: null }));

      const app = new Hono();
      app.onError(handleError);
      app.route("/api/auth", publicAuth);
      const method = await app.request("/api/auth/method");
      assert.equal(method.status, 503); // used to claim password sign-in is off
      const login = await app.request("/api/auth/password/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "owner", password: "correct horse battery" }),
      });
      assert.equal(login.status, 503);
      // the attempt was reserved, then given back: an outage is not the visitor's failed attempt
      assert.deepEqual(rpcCalls, ["reserve_login_attempt", "refund_login_attempt"]);

      // signed-in routes: no misleading "not enabled" answers or credential writes during an outage
      const session = new Hono();
      session.onError(handleError);
      session.use("*", async (c, next) => {
        // deno-lint-ignore no-explicit-any
        (c as any).set("session", {
          sub: 42,
          via: "telegram",
          iat: Date.now() - 3_600_000,
          exp: Date.now() + 3_600_000,
          v: 1,
        });
        await next();
      });
      session.route("/", privateAuth);
      const json = (method: string, path: string, body: unknown) =>
        session.request(path, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      assert.equal((await session.request("/me")).status, 503);
      const credentials = { username: "owner", password: "correct-horse-battery-1" };
      assert.equal((await json("POST", "/password/setup", credentials)).status, 503);
      assert.equal((await json("PATCH", "/password", { ...credentials, current_password: "x" })).status, 503);
    } finally {
      restore();
    }
  });

  Deno.test("owner lookup: healthy database behaves as before", async () => {
    try {
      const answer = (data: unknown) => ({
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data, error: null }) }) }),
      });
      const app = new Hono();
      app.onError(handleError);
      app.route("/api/auth", publicAuth);
      client.from = () => answer({ password_enabled: true, login_username: "owner" });
      assert.deepEqual(await (await app.request("/api/auth/method")).json(), { password_enabled: true });
      client.from = () => answer(null); // the owner has not signed in yet
      assert.deepEqual(await (await app.request("/api/auth/method")).json(), { password_enabled: false });
    } finally {
      restore();
    }
  });
}

// ======================================================================
// bug fixes: one regression test per fix
// ======================================================================
{
  Deno.env.set("BOT_USERNAME", "ci_bot");
  const { db } = await import("./db.ts");
  const { fileRoutes } = await import("./routes/files.ts");
  const { isRangeError } = await import("./lib.ts");
  const { failureReply } = await import("./botErrors.ts");

  // deno-lint-ignore no-explicit-any
  const client = db as any;
  const realFrom = client.from;

  type Call = [string, unknown[]];
  /** A query builder that records every call and answers when awaited, based on the table and the calls made. */
  const stubDatabase = (
    answer: (table: string, calls: Call[]) => unknown,
    log: Record<string, unknown[]> = {},
  ) => {
    client.from = (table: string) => {
      const calls: Call[] = [];
      const builder: unknown = new Proxy({}, {
        get: (_target, name: string) => {
          if (name === "then") {
            return (ok: (value: unknown) => unknown, bad: (reason: unknown) => unknown) => {
              for (const [method, args] of calls) if (method === "insert") (log[table] ??= []).push(args[0]);
              return Promise.resolve(answer(table, calls)).then(ok, bad);
            };
          }
          return (...args: unknown[]) => {
            calls.push([name, args]);
            return builder;
          };
        },
      });
      return builder;
    };
  };
  const rangeOf = (calls: Call[]) =>
    calls.find(([method]) => method === "range")?.[1] as [number, number] | undefined;
  const pastTheEnd = {
    data: null,
    count: null,
    error: { code: "PGRST103", message: "Requested range not satisfiable" },
  };
  const app = () => {
    const instance = new Hono();
    instance.route("/", fileRoutes);
    return instance;
  };
  const JSON_HEADERS = { "Content-Type": "application/json" };

  Deno.test("isRangeError: only the out-of-range database error counts", () => {
    assert.equal(isRangeError({ code: "PGRST103", message: "x" }), true);
    assert.equal(isRangeError({ message: "Requested range not satisfiable" }), true);
    assert.equal(isRangeError({ code: "PGRST301", message: "JWT expired" }), false);
    assert.equal(isRangeError({ message: "database unreachable" }), false);
    assert.equal(isRangeError(null), false);
    assert.equal(isRangeError(undefined), false);
  });

  Deno.test("failureReply: only the owner is pointed at the app and its Settings", () => {
    const owner = failureReply("I couldn't open this shared file.", true);
    assert.equal(owner.withApp, true);
    assert.match(owner.text, /Settings/);
    const stranger = failureReply("I couldn't open this shared file.", false);
    assert.equal(stranger.withApp, false);
    assert.doesNotMatch(stranger.text, /Settings|Cloud Drive/);
    assert.match(stranger.text, /try the link again/);
  });

  Deno.test("GET /files: a page past the end is an empty page with the real total, not a 500", async () => {
    try {
      stubDatabase((_table, calls) => {
        const range = rangeOf(calls);
        if (range && range[0] === 0 && range[1] === 0) return { data: [], count: 7, error: null }; // the count probe
        return pastTheEnd;
      });
      const response = await app().request("/files?page=3&limit=50");
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { items: [], page: 3, limit: 50, total: 7, has_more: false });
    } finally {
      client.from = realFrom;
    }
  });

  Deno.test("GET /files: other database errors still answer 500, and page 1 never takes the empty-page path", async () => {
    try {
      stubDatabase(() => ({ data: null, count: null, error: { message: "database unreachable" } }));
      assert.equal((await app().request("/files?page=3")).status, 500);
      stubDatabase(() => pastTheEnd); // even a range error on page 1 is reported, not hidden
      assert.equal((await app().request("/files?page=1")).status, 500);
      stubDatabase(() => ({ data: [{ id: "a" }], count: 1, error: null }));
      const ok = await app().request("/files?page=1");
      assert.equal(ok.status, 200);
      assert.equal(((await ok.json()) as { total: number }).total, 1);
    } finally {
      client.from = realFrom;
    }
  });

  Deno.test("GET /trash: a files page past the end is empty with the real total, not a 500", async () => {
    try {
      stubDatabase((table, calls) => {
        if (table === "trashed_folders") return { data: null, count: 0, error: null };
        const range = rangeOf(calls);
        if (range && range[0] > 0) return pastTheEnd;
        return { data: null, count: 5, error: null }; // the count probe has no range
      });
      const response = await app().request("/trash?page=2&limit=50");
      assert.equal(response.status, 200);
      const body = await response.json() as { items: unknown[]; total: number; has_more: boolean };
      assert.deepEqual(body.items, []);
      assert.equal(body.total, 5);
      assert.equal(body.has_more, false);
    } finally {
      client.from = realFrom;
    }
  });

  Deno.test("PATCH /files/:id: renaming and moving in one request logs both actions", async () => {
    const id = "33333333-3333-4333-8333-3333333333f1";
    const log: Record<string, unknown[]> = {};
    try {
      stubDatabase((table, calls) => {
        if (table === "activity_logs") return { error: null };
        const updating = calls.some(([method]) => method === "update");
        return { data: { id, file_name: updating ? "new.txt" : "old.txt" }, error: null };
      }, log);
      const response = await app().request(`/files/${id}`, {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({ file_name: "new", folder_id: null }),
      });
      assert.equal(response.status, 200);
      const actions = (log["activity_logs"] ?? []).map((row) => (row as { action: string }).action);
      assert.deepEqual(actions, ["file_rename", "file_move"]);

      log["activity_logs"] = [];
      await app().request(`/files/${id}`, {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({ folder_id: null }),
      });
      assert.deepEqual((log["activity_logs"] ?? []).map((row) => (row as { action: string }).action), [
        "file_move",
      ]);

      log["activity_logs"] = [];
      await app().request(`/files/${id}`, {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({ file_name: "new" }),
      });
      assert.deepEqual((log["activity_logs"] ?? []).map((row) => (row as { action: string }).action), [
        "file_rename",
      ]);
    } finally {
      client.from = realFrom;
    }
  });

  Deno.test("GET /favorites/ids: returns every favourite, reading in pages of 1000", async () => {
    const rows = (from: number, count: number) =>
      Array.from({ length: count }, (_, index) => ({ file_id: `id-${from + index}` }));
    try {
      stubDatabase((_table, calls) => {
        const range = rangeOf(calls)!;
        return { data: range[0] === 0 ? rows(0, 1000) : rows(1000, 3), error: null };
      });
      const response = await app().request("/favorites/ids");
      assert.equal(response.status, 200);
      const { ids } = await response.json() as { ids: string[] };
      assert.equal(ids.length, 1003);
      assert.equal(ids[0], "id-0");
      assert.equal(ids[1002], "id-1002");

      stubDatabase(() => ({ data: [], error: null }));
      assert.deepEqual(await (await app().request("/favorites/ids")).json(), { ids: [] });

      stubDatabase(() => ({ data: null, error: { message: "database unreachable" } }));
      assert.equal((await app().request("/favorites/ids")).status, 500);
    } finally {
      client.from = realFrom;
    }
  });
}

// ======================================================================
// albums across servers, and slow saves
// ======================================================================
{
  const { waitUpTo, runWithSlowNotice } = await import("./lib.ts");
  const { db } = await import("./db.ts");
  const { databaseAlbums, albumTableMissing } = await import("./albumDb.ts");
  const noSleep = () => Promise.resolve();
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  /** An in-memory stand-in for the album tables: what the database does for every server instance. */
  const memoryAlbums = () => {
    const rows = new Map<string, { status: number | null; tally: Required<AlbumTally> }>();
    const store: SharedAlbum = {
      claim: (key) => {
        if (rows.has(key)) return Promise.resolve(false);
        rows.set(key, {
          status: null,
          tally: { saved: 0, duplicate: 0, trashed: 0, empty: 0, failed: 0, slow: 0 },
        });
        return Promise.resolve(true);
      },
      setStatus: (key, id) => (rows.get(key)!.status = id, Promise.resolve()),
      getStatus: (key) => Promise.resolve(rows.get(key)?.status ?? null),
      record: (key, outcome, wasSlow) => {
        const tally = rows.get(key)!.tally;
        if (outcome === "slow") tally.slow++;
        else {
          tally[outcome]++;
          if (wasSlow) tally.slow = Math.max(0, tally.slow - 1);
        }
        return Promise.resolve({ ...tally });
      },
      read: (key) => Promise.resolve({ ...rows.get(key)!.tally }),
    };
    return { store, rows };
  };
  const server = (store?: SharedAlbum) =>
    new AlbumReports(120_000, Date.now, { shared: store, sleep: noSleep });
  const zero = { saved: 0, duplicate: 0, trashed: 0, empty: 0, failed: 0 };

  Deno.test("waitUpTo: finishes in time, runs late, or fails exactly like the work", async () => {
    const quick = await waitUpTo(Promise.resolve(5), 1000);
    assert.deepEqual(quick, { done: true, value: 5 });

    const slow = await waitUpTo(wait(40).then(() => "x"), 5);
    assert.equal(slow.done, false);
    if (!slow.done) assert.equal(await slow.late, "x");

    await assert.rejects(waitUpTo(Promise.reject(new Error("boom")), 1000), /boom/);

    const failsLate = await waitUpTo(wait(40).then(() => Promise.reject(new Error("late boom"))), 5);
    assert.equal(failsLate.done, false);
    if (!failsLate.done) await assert.rejects(failsLate.late, /late boom/);
  });

  Deno.test("runWithSlowNotice: a slow save is reported once and still delivers its result", async () => {
    let notices = 0;
    const fast = await runWithSlowNotice(Promise.resolve("ok"), 1000, () => (notices++, Promise.resolve()));
    assert.deepEqual(fast, { value: "ok", slow: false });
    assert.equal(notices, 0);

    const order: string[] = [];
    const slow = await runWithSlowNotice(
      wait(40).then(() => (order.push("finished"), "saved")),
      5,
      () => (order.push("notice"), Promise.resolve()),
    );
    assert.deepEqual(slow, { value: "saved", slow: true });
    assert.deepEqual(order, ["notice", "finished"]); // the notice goes out first, the result still arrives

    const noticeFails = await runWithSlowNotice(
      wait(30).then(() => 1),
      5,
      () => Promise.reject(new Error("telegram")),
    );
    assert.deepEqual(noticeFails, { value: 1, slow: true }); // a failed notice never loses the save

    let noticed = false;
    await assert.rejects(
      runWithSlowNotice(
        wait(30).then(() => Promise.reject(new Error("copy failed"))),
        5,
        () => (noticed = true, Promise.resolve()),
      ),
      /copy failed/,
    );
    assert.equal(noticed, true); // a save that fails after the notice is still a failure the caller can report
  });

  Deno.test("albumSummary: files still saving are shown, and never counted as saved", () => {
    assert.equal(
      albumSummary({ ...zero, saved: 1, slow: 2 }),
      "⏳ Album: 1 saved, 2 still saving.\nIf this doesn't update within a minute, send those files again - nothing will be duplicated.",
    );
    assert.equal(
      albumSummary({ ...zero, failed: 1, slow: 1 }),
      "⚠️ Album: 1 failed, 1 still saving.\nSend the failed files again - nothing else was lost.\nIf this doesn't update within a minute, send those files again - nothing will be duplicated.",
    );
    assert.equal(albumSummary({ ...zero, saved: 3, slow: 0 }), "✅ Album: 3 saved.");
  });

  Deno.test("albums: files reaching two servers share ONE status message and one combined result", async () => {
    const { store } = memoryAlbums();
    let opened = 0;
    let screen = "";
    const open = () => (opened++, Promise.resolve(9));
    const edit = (_id: number, text: string) => (screen = text, Promise.resolve());
    const a = server(store).join("chat:album", open, edit);
    const b = server(store).join("chat:album", open, edit);
    const c = server(store).join("chat:album", open, edit);
    await Promise.all([a.record("saved"), b.record("failed"), c.record("saved")]);
    assert.equal(opened, 1);
    assert.equal(
      screen,
      "⚠️ Album: 2 saved, 1 failed.\nSend the failed files again - nothing else was lost.",
    );
  });

  Deno.test("albums: an older edit landing late is corrected, so the screen always ends on the full result", async () => {
    const { store } = memoryAlbums();
    let release!: () => void;
    const aHasCounted = new Promise<void>((resolve) => release = resolve);
    // Server A counts first but its Telegram edit is slow; server B counts second and edits at once.
    const storeA: SharedAlbum = {
      ...store,
      record: async (key, outcome, wasSlow) => {
        const tally = await store.record(key, outcome, wasSlow);
        release();
        return tally;
      },
    };
    const storeB: SharedAlbum = {
      ...store,
      record: async (key, outcome, wasSlow) => (await aHasCounted, store.record(key, outcome, wasSlow)),
    };
    let screen = "";
    const slowEdit = async (_id: number, text: string) => (await wait(30), screen = text, undefined);
    const fastEdit = (_id: number, text: string) => (screen = text, Promise.resolve());
    const a = server(storeA).join("k", () => Promise.resolve(1), slowEdit);
    const b = server(storeB).join("k", () => Promise.resolve(1), fastEdit);
    await Promise.all([a.record("saved"), b.record("failed")]);
    assert.match(screen, /1 saved, 1 failed/);
  });

  Deno.test("albums: if the shared tally is unavailable, each server still reports its own files", async () => {
    const down = (): Promise<never> => Promise.reject(new Error("database unreachable"));
    const unavailable: SharedAlbum = {
      claim: down,
      setStatus: down,
      getStatus: down,
      record: down,
      read: down,
    };
    let opened = 0;
    let screen = "";
    const open = () => (opened++, Promise.resolve(3));
    const edit = (_id: number, text: string) => (screen = text, Promise.resolve());
    await server(unavailable).join("k", open, edit).record("saved");
    assert.equal(opened, 1);
    assert.equal(screen, "✅ Album: 1 saved.");

    // The status message is shared but the counters fail: this server's own count is shown, nothing throws.
    const { store } = memoryAlbums();
    await server({ ...store, record: down }).join("j", open, edit).record("duplicate");
    assert.equal(screen, "✅ Album: 1 already in your Cloud Drive.");
  });

  Deno.test("albums: a later server whose first server never published a message opens its own", async () => {
    const { store } = memoryAlbums();
    await store.claim("k"); // claimed elsewhere, but the status message never got published
    let opened = 0;
    let screen = "";
    const reports = new AlbumReports(120_000, Date.now, {
      shared: store,
      waitMs: 2,
      pollMs: 1,
      sleep: noSleep,
    });
    await reports.join(
      "k",
      () => (opened++, Promise.resolve(8)),
      (_id, text) => (screen = text, Promise.resolve()),
    )
      .record("saved");
    assert.equal(opened, 1);
    assert.equal(screen, "✅ Album: 1 saved.");
  });

  Deno.test("albums: a file that is slow shows as still saving and settles to its real outcome", async () => {
    for (const shared of [false, true]) {
      const screens: string[] = [];
      const edit = (_id: number, text: string) => (screens.push(text), Promise.resolve());
      const file = server(shared ? memoryAlbums().store : undefined).join(
        "k",
        () => Promise.resolve(2),
        edit,
      );
      await file.delayed();
      assert.match(screens.at(-1)!, /^⏳ Album: 1 still saving\./);
      await file.record("saved", true);
      assert.equal(screens.at(-1), "✅ Album: 1 saved."); // no longer "still saving"
    }
  });

  Deno.test("album database store: maps the counters, and every database error is thrown", async () => {
    // deno-lint-ignore no-explicit-any
    const client = db as any;
    const realRpc = client.rpc;
    const realFrom = client.from;
    try {
      const row = { n_saved: 2, n_duplicate: 1, n_trashed: 0, n_empty: 0, n_failed: 1, n_slow: 3 };
      const calls: { name: string; args: unknown }[] = [];
      let answer: unknown = { data: true, error: null };
      client.rpc = (name: string, args: unknown) => (calls.push({ name, args }), Promise.resolve(answer));

      assert.equal(await databaseAlbums.claim("k"), true);
      answer = { data: false, error: null };
      assert.equal(await databaseAlbums.claim("k"), false);
      answer = { data: null, error: { message: "boom" } };
      await assert.rejects(databaseAlbums.claim("k"));

      answer = { data: [row], error: null };
      assert.deepEqual(await databaseAlbums.record("k", "saved", true), {
        saved: 2,
        duplicate: 1,
        trashed: 0,
        empty: 0,
        failed: 1,
        slow: 3,
      });
      assert.deepEqual(calls.at(-1), {
        name: "record_album",
        args: { p_key: "k", p_outcome: "saved", p_was_slow: true },
      });
      answer = { data: [], error: null };
      await assert.rejects(databaseAlbums.record("k", "saved", false));
      answer = { data: null, error: { message: "boom" } };
      await assert.rejects(databaseAlbums.record("k", "saved", false));

      const table = (result: unknown) => ({
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(result) }) }),
        update: () => ({ eq: () => Promise.resolve(result) }),
      });
      client.from = () => table({ data: { status_message_id: 42 }, error: null });
      assert.equal(await databaseAlbums.getStatus("k"), 42);
      client.from = () => table({ data: null, error: null });
      assert.equal(await databaseAlbums.getStatus("k"), null);
      await assert.rejects(databaseAlbums.read("k")); // a missing row is an error, not an empty tally
      client.from = () => table({ data: row, error: null });
      assert.equal((await databaseAlbums.read("k")).slow, 3);
      await databaseAlbums.setStatus("k", 5);
      client.from = () => table({ data: null, error: { message: "boom" } });
      await assert.rejects(databaseAlbums.setStatus("k", 5));
      await assert.rejects(databaseAlbums.getStatus("k"));
    } finally {
      client.rpc = realRpc;
      client.from = realFrom;
    }
  });

  Deno.test("maintenance: old album counters are cleaned; a missing optional table stays silent", async () => {
    const { runMaintenance } = await import("./maintenance.ts");
    // deno-lint-ignore no-explicit-any
    const client = db as any;
    const realRpc = client.rpc;
    const realFrom = client.from;
    const realError = console.error;
    const logged: string[] = [];
    try {
      console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
      client.rpc = () => Promise.resolve({ data: [], error: null });
      for (
        const [albumError, shouldLog] of [[null, false], [
          { code: "PGRST205", message: "no such table" },
          false,
        ], [{ message: "real failure" }, true]] as const
      ) {
        logged.length = 0;
        let cutoff = "";
        client.from = (table: string) => {
          if (table === "album_reports") {
            return {
              delete: () => ({
                lt: (
                  column: string,
                  value: string,
                ) => (assert.equal(column, "created_at"),
                  cutoff = value,
                  Promise.resolve({ error: albumError })),
              }),
            };
          }
          return {
            delete: () => ({ lt: () => Promise.resolve({ count: 0, error: null }) }),
            select: () => ({
              lte: () => ({ order: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }) }),
            }),
          };
        };
        await runMaintenance();
        const age = Date.now() - Date.parse(cutoff);
        assert.ok(age > 86_000_000 && age < 87_000_000, "counters older than a day are removed");
        assert.equal(logged.some((line) => line.includes("album counters")), shouldLog);
      }
    } finally {
      console.error = realError;
      client.rpc = realRpc;
      client.from = realFrom;
    }
  });

  Deno.test("albumTableMissing: only a missing table or function counts, not an outage", () => {
    for (const code of ["PGRST205", "42P01", "PGRST202", "42883"]) {
      assert.equal(albumTableMissing({ code }), true);
    }
    assert.equal(albumTableMissing({ code: "PGRST301" }), false);
    assert.equal(albumTableMissing({}), false);
    assert.equal(albumTableMissing(null), false);
  });
}

{
  const { extractMedia } = await import("./storage.ts");
  // 2026-11-10 14:32:05 UTC
  const date = Date.UTC(2026, 10, 10, 14, 32, 5) / 1000;
  const base = { message_id: 9, date, chat: { id: 1, type: "private" } } as never;
  const make = (extra: Record<string, unknown>) => ({ ...(base as object), ...extra }) as never;

  Deno.test("extractMedia: Telegram's own file name always wins", () => {
    const item = extractMedia(make({
      document: {
        file_id: "a",
        file_unique_id: "u",
        file_name: "Report 2026.pdf",
        mime_type: "application/pdf",
      },
      caption: "ignored",
    }));
    assert.equal(item?.filename, "Report 2026.pdf");
  });

  Deno.test("extractMedia: audio without a file name uses performer and title", () => {
    const item = extractMedia(make({
      audio: {
        file_id: "a",
        file_unique_id: "u",
        performer: "Artist",
        title: "Song",
        mime_type: "audio/mpeg",
      },
    }));
    assert.equal(item?.filename, "Artist - Song.mp3");
  });

  Deno.test("extractMedia: nameless media uses the first caption line, then the message date", () => {
    const captioned = extractMedia(make({
      video: { file_id: "v", file_unique_id: "u", mime_type: "video/mp4" },
      caption: "Trip to Kandy\nday two",
    }));
    assert.equal(captioned?.filename, "Trip to Kandy.mp4");
    const plain = extractMedia(
      make({ video: { file_id: "v", file_unique_id: "u", mime_type: "video/mp4" } }),
    );
    assert.equal(plain?.filename, "video_2026-11-10_14-32-05.mp4");
    const voice = extractMedia(
      make({ voice: { file_id: "v", file_unique_id: "u", mime_type: "audio/ogg" } }),
    );
    assert.equal(voice?.filename, "voice_2026-11-10_14-32-05.ogg");
    const photo = extractMedia(make({ photo: [{ file_id: "p", file_unique_id: "u" }] }));
    assert.equal(photo?.filename, "photo_2026-11-10_14-32-05.jpg");
  });

  Deno.test("extractMedia: names never contain path separators or line breaks", () => {
    const item = extractMedia(make({
      video: { file_id: "v", file_unique_id: "u", file_name: "a/b\\c\nd.mp4" },
    }));
    assert.equal(item?.filename, "a b c d.mp4");
  });
}
