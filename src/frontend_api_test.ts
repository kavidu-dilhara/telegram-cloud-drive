import assert from "node:assert/strict";
import { api, ApiError, setToken, setUnauthorizedHandler } from "../frontend/src/api.ts";

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
