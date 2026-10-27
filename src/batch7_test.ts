import "./test_env.ts";
import assert from "node:assert/strict";
import { Hono } from "hono";

Deno.env.set("BOT_USERNAME", "ci_bot");
const { db } = await import("./db.ts");
const { config } = await import("./config.ts");
const { redactSecrets, describeError, logError } = await import("./redact.ts");
const { handleError } = await import("./http.ts");
const { formatSize } = await import("./lib.ts");
const { formatSize: frontendFormatSize } = await import("../frontend/src/format.ts");
const { storeIncoming } = await import("./storage.ts");
const { bot, retryPendingDeletions, drainPendingDeletions } = await import("./telegram.ts");
const { encryptToken, decryptToken, createSession, verifySession, RECENT_SIGNIN_MS } = await import(
  "./security.ts"
);
const { publicAuth, privateAuth } = await import("./routes/auth.ts");
const { fileRoutes } = await import("./routes/files.ts");

// deno-lint-ignore no-explicit-any
const client = db as any;
const realFrom = client.from;
const realRpc = client.rpc;
const restore = () => {
  client.from = realFrom;
  client.rpc = realRpc;
};
const json = (method: string, body?: unknown) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const FILE = "22222222-2222-4222-8222-2222222222f1";

// ================================================================ 3. the bot token never reaches a log

Deno.test("redactSecrets: the bot token is removed from any text, in any URL form", () => {
  const token = config.botToken;
  const urls = [
    `https://api.telegram.org/bot${token}/getFile?file_id=x`,
    `https://api.telegram.org/file/bot${token}/photos/a.png`,
    `request to https://api.telegram.org/bot987654321:AAH-fake_Token-0123456789abcdefghijk/getMe failed`,
    `token=${token}`,
  ];
  for (const url of urls) {
    const out = redactSecrets(url);
    assert.ok(!out.includes(token), out);
    assert.ok(!/bot\d{3,}:[A-Za-z0-9_-]{10,}/.test(out), out);
  }
  assert.equal(redactSecrets("nothing secret here"), "nothing secret here");
  for (const secret of [config.sessionSecret, config.webhookSecret, config.supabaseKey]) {
    assert.ok(!redactSecrets(`a ${secret} b`).includes(secret));
  }
});

Deno.test("describeError: causes are included but the token is not", () => {
  const url = `https://api.telegram.org/file/bot${config.botToken}/photos/a.png`;
  const error = new TypeError("fetch failed", {
    cause: new Error(`error sending request for url (${url}): client error (Connect)`),
  });
  const text = describeError(error);
  assert.ok(text.includes("error sending request for url"), "the useful part is kept");
  assert.ok(!text.includes(config.botToken));
});

Deno.test("handleError and logError never print the token", async () => {
  const real = console.error;
  const lines: string[] = [];
  try {
    console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    const app = new Hono();
    app.onError(handleError);
    app.get("/boom", () => {
      throw new TypeError("fetch failed", {
        cause: new Error(`url (https://api.telegram.org/bot${config.botToken}/getFile)`),
      });
    });
    assert.equal((await app.request("/boom")).status, 500);
    logError("Bot error", {
      nested: { error: new Error(`https://api.telegram.org/bot${config.botToken}/sendMessage`) },
    });
    assert.ok(lines.length >= 2);
    assert.ok(!lines.join("\n").includes(config.botToken));
  } finally {
    console.error = real;
  }
});

Deno.test("image preview: a failing Telegram request is a 502 and the log has no token", async () => {
  const realFetch = globalThis.fetch;
  const real = console.error;
  const lines: string[] = [];
  try {
    console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    client.from = () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({
                data: { telegram_file_id: "tg", file_size: 10, mime_type: "image/png", file_name: "a.png" },
                error: null,
              }),
          }),
        }),
      }),
    });
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      return url.includes("/getFile")
        ? Promise.resolve(new Response(JSON.stringify({ result: { file_path: "photos/a.png" } })))
        : Promise.reject(
          new TypeError("fetch failed", { cause: new Error(`error sending request for url (${url})`) }),
        );
    }) as typeof fetch;
    const app = new Hono();
    app.onError(handleError);
    app.route("/", fileRoutes);
    const response = await app.request(`/files/${FILE}/preview`);
    assert.equal(response.status, 502);
    assert.ok(lines.some((line) => line.includes("Image preview")));
    assert.ok(!lines.join("\n").includes(config.botToken), "the token must not be logged");
  } finally {
    globalThis.fetch = realFetch;
    console.error = real;
    restore();
  }
});

// ================================================================ 4. size formatting

Deno.test("formatSize: values that round up move to the next unit (backend and frontend agree)", () => {
  const cases: Array<[number, string]> = [
    [0, "0 B"],
    [1, "1 B"],
    [1023, "1023 B"],
    [1024, "1 KB"],
    [1536, "2 KB"],
    [1048575, "1.00 MB"],
    [1048576, "1.00 MB"],
    [1572864, "1.50 MB"],
    [1073741823, "1.00 GB"],
    [1073741824, "1.00 GB"],
    [5 * 1073741824, "5.00 GB"],
    [Number.NaN, "0 B"],
    [-5, "0 B"],
  ];
  for (const [bytes, expected] of cases) {
    assert.equal(formatSize(bytes), expected, `backend ${bytes}`);
    assert.equal(frontendFormatSize(bytes), expected, `frontend ${bytes}`);
  }
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let i = 0; i < 5000; i++) {
    const bytes = Math.floor(rnd() ** 4 * 2 ** 42);
    const text = formatSize(bytes);
    assert.equal(frontendFormatSize(bytes), text);
    assert.doesNotMatch(text, /^1024 KB$|^1024\.00 MB$/, `${bytes} -> ${text}`);
  }
});

// ================================================================ 2. uploads: choose the folder first, never leave a copy behind

/** A database for storeIncoming. `folderLookup` decides what the "incoming folder" lookups answer. */
function uploadDb(options: { insert: () => Promise<unknown>; settingFails?: boolean }) {
  client.from = (table: string) => {
    if (table === "settings") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve(
                options.settingFails
                  ? { data: null, error: { message: "boom" } }
                  : { data: null, error: null },
              ),
          }),
        }),
      };
    }
    // deno-lint-ignore no-explicit-any
    const chain: any = {
      select: () => chain,
      match: () => chain,
      is: () => chain,
      eq: () => chain,
      limit: () => chain,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      insert: () => ({ select: () => ({ single: options.insert }) }),
    };
    return chain;
  };
}
const message = (id: number) =>
  // deno-lint-ignore no-explicit-any
  ({
    message_id: id,
    chat: { id: 7 },
    date: 1,
    document: {
      file_id: "f",
      file_unique_id: "u" + id,
      file_name: "a.png",
      mime_type: "image/png",
      file_size: 10,
    },
  }) as any;

async function withTelegram(run: (calls: { copies: number; deleted: number[] }) => Promise<void>) {
  const realCopy = bot.api.copyMessage;
  const realDelete = bot.api.deleteMessage;
  const calls = { copies: 0, deleted: [] as number[] };
  // deno-lint-ignore no-explicit-any
  const api = bot.api as any;
  api.copyMessage = () => (calls.copies++, Promise.resolve({ message_id: 900 + calls.copies }));
  api.deleteMessage = (_chat: number, id: number) => (calls.deleted.push(id), Promise.resolve(true));
  try {
    await run(calls);
  } finally {
    api.copyMessage = realCopy;
    api.deleteMessage = realDelete;
    restore();
  }
}

Deno.test("upload: if the destination folder cannot be looked up, nothing is copied", async () => {
  await withTelegram(async (calls) => {
    uploadDb({ insert: () => Promise.resolve({ data: { id: "x" }, error: null }), settingFails: true });
    await assert.rejects(() => storeIncoming(message(601)), /Unable to read settings/);
    assert.equal(calls.copies, 0, "no channel copy was made");
    assert.deepEqual(calls.deleted, []);
  });
});

Deno.test("upload: any failure after the copy removes the copy (insert error, thrown error, duplicate)", async () => {
  await withTelegram(async (calls) => {
    uploadDb({ insert: () => Promise.resolve({ data: null, error: { code: "XX000", message: "boom" } }) });
    await assert.rejects(() => storeIncoming(message(602)));
    assert.deepEqual(calls.deleted, [901]);

    uploadDb({ insert: () => Promise.reject(new Error("network down")) });
    await assert.rejects(() => storeIncoming(message(603)), /network down/);
    assert.deepEqual(calls.deleted, [901, 902]);

    uploadDb({
      insert: () => Promise.resolve({ data: null, error: { code: "23505", message: "duplicate" } }),
    });
    assert.deepEqual(await storeIncoming(message(604)), { status: "duplicate", inTrash: false });
    assert.deepEqual(calls.deleted, [901, 902, 903]);

    uploadDb({ insert: () => Promise.resolve({ data: { id: "new" }, error: null }) });
    const stored = await storeIncoming(message(605));
    assert.equal(stored.status, "stored");
    assert.deepEqual(calls.deleted, [901, 902, 903], "a successful upload keeps its copy");
  });
});

Deno.test("upload: a copy that cannot be deleted is queued for retry, not forgotten", async () => {
  const realCopy = bot.api.copyMessage;
  const realDelete = bot.api.deleteMessage;
  const queued: unknown[] = [];
  try {
    uploadDb({ insert: () => Promise.resolve({ data: null, error: { code: "XX000", message: "boom" } }) });
    const fromWithQueue = client.from;
    client.from = (table: string) =>
      table === "pending_message_deletions"
        ? { upsert: (row: unknown) => (queued.push(row), Promise.resolve({ error: null })) }
        : fromWithQueue(table);
    // deno-lint-ignore no-explicit-any
    const api = bot.api as any;
    api.copyMessage = () => Promise.resolve({ message_id: 777 });
    api.deleteMessage = () => Promise.reject({ description: "Bad Request: message can't be deleted" });
    await assert.rejects(() => storeIncoming(message(606)));
    assert.equal(queued.length, 1);
    assert.equal((queued[0] as { message_id: number }).message_id, 777);
  } finally {
    bot.api.copyMessage = realCopy;
    bot.api.deleteMessage = realDelete;
    restore();
  }
});

// ================================================================ share keys

Deno.test("share links: a separate key lets SESSION_SECRET change; old links stay readable", async () => {
  const legacyKey = "legacy-session-secret-0123456789-abcdefghijklmnop"; // what links were encrypted with before SHARE_SECRET
  const shareKey = "dedicated-share-secret-0123456789-abcdefghijklmnop";
  const old = await encryptToken("token-made-long-ago", legacyKey);
  const fresh = await encryptToken("token-made-today", shareKey);
  // with SHARE_SECRET set, reads try it first and then the old key
  assert.equal(await decryptToken(old, [shareKey, legacyKey]), "token-made-long-ago");
  assert.equal(await decryptToken(fresh, [shareKey, legacyKey]), "token-made-today");
  // a different key cannot read either (this is what used to happen after rotating SESSION_SECRET)
  assert.equal(await decryptToken(old, ["a-completely-different-secret-0123456789-abcdef"]), null);
  assert.equal(await decryptToken(fresh, [legacyKey]), null);
  assert.equal(await decryptToken(null, [shareKey]), null);
  assert.equal(await decryptToken("not.valid", [shareKey]), null);
  // default keys: no SHARE_SECRET in the test environment, so the session secret is used (nothing changes by default)
  assert.equal(config.shareSecretIsSeparate, false);
  assert.equal(await decryptToken(await encryptToken("plain")), "plain");
});

// ================================================================ delete queue

function queueStub(initial: Array<{ chat_id: number; message_id: number; attempts: number }>) {
  let rows = [...initial];
  const log = { deletedFromQueue: [] as number[], updates: [] as unknown[], telegram: [] as number[] };
  client.from = (table: string) => {
    if (table === "files") {
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ count: 0, error: null }).then(resolve),
      };
      return chain;
    }
    return {
      select: () => ({
        lte: () => ({
          order: () => ({ limit: (n: number) => Promise.resolve({ data: rows.slice(0, n), error: null }) }),
        }),
      }),
      delete: () => ({
        match: (
          key: { message_id: number },
        ) => ((rows = rows.filter((r) => r.message_id !== key.message_id)),
          log.deletedFromQueue.push(key.message_id),
          Promise.resolve({ error: null })),
      }),
      update: (values: unknown) => ({
        match: (
          key: { message_id: number },
        ) => ((rows = rows.filter((r) => r.message_id !== key.message_id)),
          log.updates.push({ values, key }),
          Promise.resolve({ error: null })),
      }),
    };
  };
  return log;
}

Deno.test("drain: works through the whole queue; failures are rescheduled, not retried in a tight loop", async () => {
  const realDelete = bot.api.deleteMessage;
  try {
    const rows = Array.from({ length: 60 }, (_, i) => ({ chat_id: -100, message_id: i + 1, attempts: 1 }));
    const log = queueStub(rows);
    // deno-lint-ignore no-explicit-any
    (bot.api as any).deleteMessage = (
      _chat: number,
      id: number,
    ) => (log.telegram.push(id),
      id === 13
        ? Promise.reject({ description: "Bad Request: message can't be deleted" })
        : Promise.resolve(true));
    const result = await drainPendingDeletions(30_000);
    assert.deepEqual(result, { deleted: 59, gaveUp: 0 });
    assert.equal(log.telegram.length, 60, "every message was tried exactly once");
    assert.equal(log.updates.length, 1); // #13 was rescheduled for later
    assert.ok(
      new Date((log.updates[0] as { values: { next_try_at: string } }).values.next_try_at).getTime() >
        Date.now(),
    );
    assert.deepEqual(await retryPendingDeletions(), { deleted: 0, gaveUp: 0, processed: 0 }); // nothing is due any more
  } finally {
    bot.api.deleteMessage = realDelete;
    restore();
  }
});

Deno.test("drain: only one runs at a time", async () => {
  const realDelete = bot.api.deleteMessage;
  try {
    const log = queueStub([{ chat_id: -100, message_id: 1, attempts: 1 }, {
      chat_id: -100,
      message_id: 2,
      attempts: 1,
    }]);
    // deno-lint-ignore no-explicit-any
    (bot.api as any).deleteMessage = async (_chat: number, id: number) => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      log.telegram.push(id);
      return true;
    };
    const [first, second] = await Promise.all([drainPendingDeletions(), drainPendingDeletions()]);
    assert.equal(first.deleted + second.deleted, 2);
    assert.deepEqual(log.telegram.sort(), [1, 2]);
  } finally {
    bot.api.deleteMessage = realDelete;
    restore();
  }
});

Deno.test("Empty Trash and permanent file delete answer at once (Telegram is not waited for)", async () => {
  const realDelete = bot.api.deleteMessage;
  try {
    const log = queueStub([{ chat_id: -100, message_id: 5, attempts: 1 }]);
    // deno-lint-ignore no-explicit-any
    (bot.api as any).deleteMessage = async (_chat: number, id: number) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      log.telegram.push(id);
      return true;
    };
    const fromQueue = client.from;
    client.from = (table: string) => {
      if (table === "trashed_folders") return { select: () => Promise.resolve({ count: 0, error: null }) };
      if (table === "files") {
        // deno-lint-ignore no-explicit-any
        const chain: any = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () =>
            Promise.resolve({
              data: { file_name: "a.png", status: "trashed", trash_entry_id: null },
              error: null,
            }),
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ count: 0, error: null }).then(resolve),
        };
        return chain;
      }
      if (table === "activity_logs") return { insert: () => Promise.resolve({ error: null }) };
      return fromQueue(table);
    };
    client.rpc = () =>
      Promise.resolve({ data: [{ tg_chat_id: -100, tg_message_id: 5, orphaned: true }], error: null });
    const app = new Hono();
    app.onError(handleError);
    app.route("/", fileRoutes);
    for (
      const request of [
        () => app.request("/trash/empty", json("POST")),
        () => app.request(`/files/${FILE}/permanent`, json("DELETE")),
      ]
    ) {
      log.telegram.length = 0;
      const started = Date.now();
      const response = await request();
      assert.equal(response.status, 200);
      assert.ok(Date.now() - started < 150, "answered before the (slow) Telegram call could finish");
      assert.deepEqual(log.telegram, []);
      await new Promise((resolve) => setTimeout(resolve, 500)); // the background drain finishes
    }
  } finally {
    bot.api.deleteMessage = realDelete;
    restore();
  }
});

// ================================================================ logout, unlock, recent sign-in

function sessionApp(claimsOverride: Record<string, unknown> = {}) {
  const app = new Hono();
  app.onError(handleError);
  app.use("*", async (c, next) => {
    // deno-lint-ignore no-explicit-any
    (c as any).set("session", {
      sub: config.ownerId,
      via: "telegram",
      iat: Date.now() - 1000,
      at: Date.now() - 1000,
      exp: Date.now() + 3_600_000,
      v: 1,
      jti: "a".repeat(32),
      ...claimsOverride,
    });
    await next();
  });
  app.route("/", privateAuth);
  return app;
}

Deno.test("logout: signs THIS session out on the server", async () => {
  try {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    client.rpc = (
      name: string,
      args: Record<string, unknown>,
    ) => (calls.push({ name, args }), Promise.resolve({ data: null, error: null }));
    const app = new Hono();
    app.onError(handleError);
    app.route("/api/auth", publicAuth);
    const token = await createSession(config.ownerId, 1, "telegram");
    const claims = (await verifySession(token))!;
    const logout = (headers: Record<string, string>) =>
      app.request("/api/auth/logout", { method: "POST", headers });

    const ok = await logout({ Authorization: `Bearer ${token}` });
    assert.deepEqual(await ok.json(), { ok: true, revoked: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "revoke_session");
    assert.equal(calls[0].args.p_jti, claims.jti);
    assert.equal(calls[0].args.p_expires, new Date(claims.exp).toISOString());
    assert.match(ok.headers.get("Set-Cookie") ?? "", /Max-Age=0/); // the cookie is cleared too

    // the session cookie works as well as the header
    await logout({ Cookie: `drive_session=${encodeURIComponent(token)}` });
    assert.equal(calls.length, 2);

    // no valid session: nothing to revoke, still a clean answer
    calls.length = 0;
    assert.deepEqual(await (await logout({ Authorization: "Bearer garbage" })).json(), {
      ok: true,
      revoked: false,
    });
    assert.deepEqual(await (await logout({})).json(), { ok: true, revoked: false });
    assert.equal(calls.length, 0);

    // the database cannot record it: the browser is still signed out, and the answer says it was not confirmed
    client.rpc = () => Promise.resolve({ data: null, error: { message: "boom" } });
    const unconfirmed = await logout({ Authorization: `Bearer ${token}` });
    assert.equal(unconfirmed.status, 200);
    assert.deepEqual(await unconfirmed.json(), { ok: true, revoked: false });
    assert.match(unconfirmed.headers.get("Set-Cookie") ?? "", /Max-Age=0/);
  } finally {
    restore();
  }
});

Deno.test("/me: says exactly when the recent-sign-in window ends", async () => {
  const at = Date.now() - 120_000;
  try {
    client.from = () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({ data: { password_enabled: true, login_username: "owner" }, error: null }),
        }),
      }),
    });
    const me = async (app: Hono) =>
      await (await app.request("/me")).json() as {
        recent_sign_in: boolean;
        recent_sign_in_until: number | null;
        can_change_without_current_password: boolean;
      };
    const fresh = await me(sessionApp({ at }));
    assert.equal(fresh.recent_sign_in_until, at + RECENT_SIGNIN_MS);
    assert.equal(fresh.recent_sign_in, true);
    const old = await me(sessionApp({ at: Date.now() - 3 * RECENT_SIGNIN_MS }));
    assert.equal(old.recent_sign_in, false);
    assert.ok(
      old.recent_sign_in_until! < Date.now(),
      "the app can see the window has passed without asking again",
    );
    const password = await me(sessionApp({ via: "password", at: undefined }));
    assert.equal(password.recent_sign_in_until, null);
  } finally {
    restore();
  }
});

Deno.test("changing credentials without the current password says so (and does not count an attempt)", async () => {
  try {
    const rpcCalls: string[] = [];
    client.rpc = (name: string) => (rpcCalls.push(name), Promise.resolve({ data: true, error: null }));
    client.from = () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({
              data: {
                password_enabled: true,
                login_username: "owner",
                password_hash: "h",
                password_salt: "s",
                password_iterations: 600000,
              },
              error: null,
            }),
        }),
      }),
    });
    const app = sessionApp({ at: Date.now() - 3 * RECENT_SIGNIN_MS });
    for (
      const body of [{ username: "owner", password: "brand-new-password-9" }, {
        username: "owner",
        password: "brand-new-password-9",
        current_password: "",
      }]
    ) {
      const response = await app.request("/password", json("PATCH", body));
      assert.equal(response.status, 403);
      assert.equal(
        (await response.json() as { error: string }).error,
        "Enter your current password to continue.",
      );
    }
    assert.deepEqual(rpcCalls, [], "no sign-in attempt was counted");
  } finally {
    restore();
  }
});

Deno.test("unlock sign-in: a recent Telegram launch clears the lockout, an old one cannot", async () => {
  try {
    const deleted: unknown[] = [];
    client.from = (table: string) =>
      table === "login_attempts"
        ? {
          delete: (options: unknown) => ({
            neq: (
              column: string,
              value: string,
            ) => (deleted.push({ options, column, value }), Promise.resolve({ count: 3, error: null })),
          }),
        }
        : { insert: () => Promise.resolve({ error: null }) };
    const stale = await sessionApp({ at: Date.now() - 3 * RECENT_SIGNIN_MS }).request(
      "/unlock-signin",
      json("POST"),
    );
    assert.equal(stale.status, 403);
    assert.equal(deleted.length, 0);
    const passwordSession = await sessionApp({ via: "password", at: undefined }).request(
      "/unlock-signin",
      json("POST"),
    );
    assert.equal(passwordSession.status, 403); // someone who is locked out by password cannot unlock themselves with a password
    const ok = await sessionApp().request("/unlock-signin", json("POST"));
    assert.deepEqual(await ok.json(), { ok: true, cleared: 3 });
    assert.equal(deleted.length, 1);
  } finally {
    restore();
  }
});
