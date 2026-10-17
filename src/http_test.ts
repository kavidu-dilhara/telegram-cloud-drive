import "./test_env.ts";
import assert from "node:assert/strict";
import { Hono } from "hono";

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
