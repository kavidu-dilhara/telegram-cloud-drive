import "./test_env.ts";
import assert from "node:assert/strict";
import { toHex } from "./lib.ts";

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
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join(
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
