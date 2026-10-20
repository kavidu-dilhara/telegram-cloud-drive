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
      return Promise.resolve({ data: [{ o_entry: "trash-item-1", o_files: 3, o_folders: 2 }], error: null });
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
    const moved = await (await jsonPost(`/trash/folders/${ENTRY}/restore`)).json() as Record<string, unknown>;
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

Deno.test("permanent delete of a Trash folder removes only orphaned Telegram messages", async () => {
  const { bot } = await import("./telegram.ts");
  const realDelete = bot.api.deleteMessage;
  const deleted: number[] = [];
  try {
    client.from = (table: string) =>
      table === "trashed_folders"
        ? { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { name: "k" } }) }) }) }
        : { insert: () => Promise.resolve({ error: null }) };
    client.rpc = (name: string, args: unknown) => {
      assert.equal(name, "purge_trashed_folder");
      assert.deepEqual(args, { p_entry: ENTRY });
      return Promise.resolve({
        data: [
          { tg_chat_id: -100, tg_message_id: 11, orphaned: true },
          { tg_chat_id: -100, tg_message_id: 12, orphaned: false }, // a copy elsewhere still uses this one
        ],
        error: null,
      });
    };
    // deno-lint-ignore no-explicit-any
    (bot.api as any).deleteMessage = (_chat: number, message: number) => {
      deleted.push(message);
      return Promise.resolve(true);
    };
    const response = await trashApp().request(`/trash/folders/${ENTRY}`, { method: "DELETE" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, deleted_files: 2 });
    assert.deepEqual(deleted, [11]); // 12 is still used by a copy elsewhere, so it stays in the channel

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
    client.rpc = (name: string) => (rpcCalls.push(name), Promise.resolve({ data: 1, error: null }));

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
    assert.equal(rpcCalls.length, 0); // an outage is not counted as a failed password attempt

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
