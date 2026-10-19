import "./test_env.ts";
import assert from "node:assert/strict";
import { Hono } from "hono";

Deno.env.set("BOT_USERNAME", "ci_bot");
const { db } = await import("./db.ts");
const { originGuard } = await import("./routes/auth.ts");
const { systemRoutes } = await import("./routes/system.ts");
const { folderRoutes } = await import("./routes/folders.ts");
const { shareRoutes } = await import("./routes/shares.ts");
const { fileRoutes } = await import("./routes/files.ts");
const { encryptToken } = await import("./security.ts");

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
              eq: () => ({ maybeSingle: () => Promise.resolve({ data: { id: FILE, file_name: "a.png" } }) }),
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
        ? { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { name: "k" } }) }) }) }
        : { insert: (row: unknown) => (logged.push(row), Promise.resolve({ error: null })) };
    let called: unknown;
    client.rpc = (name: string, args: unknown) => {
      called = { name, args };
      return Promise.resolve({ data: 3, error: null });
    };
    const app = new Hono();
    app.route("/", folderRoutes);
    const response = await app.request(`/folders/${A}`, { method: "DELETE" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, trashed_files: 3 });
    assert.deepEqual(called, { name: "delete_folder", args: { p_id: A } });
    assert.deepEqual((logged[0] as { details: unknown }).details, { name: "k", trashed_files: 3 });

    client.rpc = () => Promise.resolve({ data: null, error: { code: "XX000", message: "boom" } });
    assert.equal((await app.request(`/folders/${A}`, { method: "DELETE" })).status, 500);
    assert.equal((await app.request(`/folders/not-a-uuid`, { method: "DELETE" })).status, 400);
  } finally {
    restore();
  }
});
