import "./test_env.ts";
import assert from "node:assert/strict";
import { Hono } from "hono";

const { db } = await import("./db.ts");
const { createSession } = await import("./security.ts");
const { requireAuth } = await import("./routes/auth.ts");

// deno-lint-ignore no-explicit-any
const client = db as any;
const realFrom = client.from;

/** Makes the users table answer with the given result (or a failure). */
const usersReturn = (result: unknown) => {
  client.from = () => ({
    select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(result) }) }),
  });
};

const app = new Hono();
app.use("*", requireAuth);
app.get("/ok", (c) => c.text("ok"));

const call = (token: string) => app.request("/ok", { headers: { Authorization: `Bearer ${token}` } });

Deno.test("sessions: a version bump takes effect on the very next request (no cache)", async () => {
  try {
    const token = await createSession(42, 1, "password");
    usersReturn({ data: { session_version: 1 }, error: null });
    assert.equal((await call(token)).status, 200);
    // Another backend instance signs out everywhere: the database now says version 2.
    usersReturn({ data: { session_version: 2 }, error: null });
    assert.equal((await call(token)).status, 401);
  } finally {
    client.from = realFrom;
  }
});

Deno.test("sessions: an unreadable session version answers 503 instead of trusting version 1", async () => {
  try {
    const token = await createSession(42, 1, "password");
    usersReturn({ data: null, error: { message: "boom" } });
    const response = await call(token);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Retry-After"), "5");
  } finally {
    client.from = realFrom;
  }
});
