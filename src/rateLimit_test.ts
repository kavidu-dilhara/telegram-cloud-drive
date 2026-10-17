import "./test_env.ts";
import assert from "node:assert/strict";
import { Hono } from "hono";

const { db } = await import("./db.ts");
const { isLimited, recordFailure, resetThrottleState, ThrottleUnavailableError } = await import(
  "./rateLimit.ts"
);
const { publicAuth } = await import("./routes/auth.ts");

// deno-lint-ignore no-explicit-any
const client = db as any;
const realFrom = client.from;
const realRpc = client.rpc;
const restore = () => {
  client.from = realFrom;
  client.rpc = realRpc;
  resetThrottleState();
};

const selectReturning = (result: unknown) => () => ({
  select: () => ({ in: () => ({ gt: () => Promise.resolve(result) }) }),
});

Deno.test("isLimited: reads counters when the database answers", async () => {
  try {
    const rows = [{ key: "user:a", failures: 10 }];
    client.from = selectReturning({ data: rows, error: null });
    assert.equal(await isLimited([{ key: "user:a", max: 10 }]), true);
    assert.equal(await isLimited([{ key: "user:a", max: 11 }]), false);
    assert.equal(await isLimited([{ key: "user:b", max: 1 }]), false);
  } finally {
    restore();
  }
});

Deno.test("isLimited: fails closed when the lookup errors, returns nothing or throws", async () => {
  try {
    for (
      const answer of [
        () => selectReturning({ data: null, error: { message: "boom" } }),
        () => selectReturning({ data: null, error: null }),
        () => () => ({ select: () => ({ in: () => ({ gt: () => Promise.reject(new Error("network")) }) }) }),
      ]
    ) {
      client.from = answer();
      await assert.rejects(() => isLimited([{ key: "x", max: 1 }]), ThrottleUnavailableError);
    }
  } finally {
    restore();
  }
});

Deno.test("recordFailure: a failed counter write makes the next check refuse", async () => {
  try {
    client.rpc = () => Promise.resolve({ data: null, error: { message: "function missing" } });
    client.from = selectReturning({ data: [], error: null });
    await recordFailure(["user:a", "global"]);
    await assert.rejects(() => isLimited([{ key: "user:a", max: 10 }]), ThrottleUnavailableError);
    resetThrottleState();
    assert.equal(await isLimited([{ key: "user:a", max: 10 }]), false);
  } finally {
    restore();
  }
});

Deno.test("recordFailure: successful writes do not degrade throttling", async () => {
  try {
    client.rpc = () => Promise.resolve({ data: 1, error: null });
    client.from = selectReturning({ data: [], error: null });
    await recordFailure(["user:a"]);
    assert.equal(await isLimited([{ key: "user:a", max: 10 }]), false);
  } finally {
    restore();
  }
});

Deno.test("password login answers 503 (not a password check) when throttling is unavailable", async () => {
  try {
    client.from = selectReturning({ data: null, error: { message: "boom" } });
    const app = new Hono();
    app.route("/api/auth", publicAuth);
    const response = await app.request("/api/auth/password/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9" },
      body: JSON.stringify({ username: "owner", password: "correct horse battery" }),
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Retry-After"), "60");
    assert.match((await response.json() as { error: string }).error, /temporarily unavailable/);
  } finally {
    restore();
  }
});

Deno.test("password login answers 429 once a limit is reached", async () => {
  try {
    client.from = selectReturning({ data: [{ key: "user:owner", failures: 10 }], error: null });
    const app = new Hono();
    app.route("/api/auth", publicAuth);
    const response = await app.request("/api/auth/password/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "whatever" }),
    });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("Retry-After"), "900");
  } finally {
    restore();
  }
});
