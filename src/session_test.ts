import "./test_env.ts";
import assert from "node:assert/strict";
import { Hono } from "hono";

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
  const signature = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(payload)))].map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
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
