import "./test_env.ts";
import assert from "node:assert/strict";
import { Hono } from "hono";

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
    const { app, log } = loginDb({ ...OWNER, password_hash: "x", password_salt: "AAAAAAAAAAAAAAAAAAAAAA" }, {
      max: 10,
    });
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
    assert.equal((log.updates[0] as { password_iterations: number }).password_iterations, PBKDF2_ITERATIONS);
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
