import "./test_env.ts";
import assert from "node:assert/strict";
import { Hono } from "hono";

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
        select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(options.file) }) }) }),
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
