import "./test_env.ts";
import assert from "node:assert/strict";
import { Hono } from "hono";

Deno.env.set("BOT_USERNAME", "ci_bot");
const { db } = await import("./db.ts");
const { config } = await import("./config.ts");
const {
  createSession,
  verifySession,
  isRecentSignIn,
  verifyMiniAppInitData,
  hashPassword,
  RECENT_SIGNIN_MS,
} = await import("./security.ts");
const { publicAuth, privateAuth } = await import("./routes/auth.ts");
const { fileRoutes } = await import("./routes/files.ts");
const { systemRoutes } = await import("./routes/system.ts");
const { handleError } = await import("./http.ts");
const { bot, deleteChannelMessages, retryPendingDeletions, MAX_DELETE_ATTEMPTS, messageAlreadyGone } =
  await import("./telegram.ts");
const { deliverShare } = await import("./share.ts");
const { ownerGuard } = await import("./botErrors.ts");
const { runMaintenance } = await import("./maintenance.ts");
const { escapeLike, lastPage, recentWebhookError, WEBHOOK_ERROR_WINDOW_MS } = await import("./lib.ts");
const { AlbumReports } = await import("./album.ts");

// deno-lint-ignore no-explicit-any
const client = db as any;
const realFrom = client.from;
const realRpc = client.rpc;
const restore = () => {
  client.from = realFrom;
  client.rpc = realRpc;
};
const json = (method: string, body: unknown) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// ============================================================ 1. old launch data is not a recent sign-in

async function signedInitData(authAgeSeconds: number, userId = config.ownerId) {
  const enc = new TextEncoder();
  const hmac = async (key: ArrayBuffer | string, data: string) =>
    await crypto.subtle.sign(
      "HMAC",
      await crypto.subtle.importKey(
        "raw",
        typeof key === "string" ? enc.encode(key) : key,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      ),
      enc.encode(data),
    );
  const authDate = Math.floor(Date.now() / 1000) - authAgeSeconds;
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: "AAH",
    user: JSON.stringify({ id: userId, first_name: "Owner" }),
  });
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join(
    "\n",
  );
  const hash = [...new Uint8Array(await hmac(await hmac("WebAppData", config.botToken), check))].map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
  params.set("hash", hash);
  return { initData: params.toString(), authDate };
}

Deno.test("verifyMiniAppInitData returns the launch time", async () => {
  const { initData, authDate } = await signedInitData(120);
  assert.equal((await verifyMiniAppInitData(initData)).auth_date, authDate);
});

Deno.test("isRecentSignIn: only a Telegram session whose LAUNCH was recent counts", () => {
  const now = Date.now();
  const base = { sub: 42, exp: now + 1e6, v: 1 };
  assert.equal(isRecentSignIn({ ...base, via: "telegram", iat: now - 5_000, at: now - 5_000 }, now), true);
  assert.equal(
    isRecentSignIn({ ...base, via: "telegram", iat: now - 1_000, at: now - 23 * 3600_000 }, now),
    false,
  ); // fresh session, old launch
  assert.equal(
    isRecentSignIn({ ...base, via: "telegram", iat: now - 1_000, at: now - RECENT_SIGNIN_MS }, now),
    false,
  );
  assert.equal(
    isRecentSignIn({ ...base, via: "telegram", iat: now - 1_000, at: now - RECENT_SIGNIN_MS + 1_000 }, now),
    true,
  );
  assert.equal(isRecentSignIn({ ...base, via: "password", iat: now, at: now }, now), false);
  assert.equal(isRecentSignIn({ ...base, via: "telegram", iat: now - 60_000 }, now), true); // token from before this change: iat is used
  assert.equal(isRecentSignIn({ ...base, via: "telegram", iat: now - 3600_000 }, now), false);
  assert.equal(isRecentSignIn({ ...base, via: "telegram", iat: now, at: now + 3600_000 }, now), false); // a launch time in the future is not trusted
});

Deno.test("createSession: the launch time can never be later than now", async () => {
  const token = await createSession(config.ownerId, 1, "telegram", undefined, Date.now() + 3600_000);
  const claims = await verifySession(token);
  assert.ok(claims && claims.at! <= Date.now());
});

Deno.test("POST /telegram: the session remembers the launch time (day-old launch data is accepted but not recent)", async () => {
  try {
    client.from = () => ({
      upsert: () => Promise.resolve({ error: null }),
      select: () => ({
        eq: () => ({ maybeSingle: () => Promise.resolve({ data: { session_version: 1 }, error: null }) }),
      }),
    });
    const app = new Hono();
    app.onError(handleError);
    app.route("/api/auth", publicAuth);
    for (const [age, recent] of [[20, true], [23 * 3600, false]] as const) {
      const { initData, authDate } = await signedInitData(age);
      const response = await app.request("/api/auth/telegram", json("POST", { initData }));
      assert.equal(response.status, 200);
      const claims = await verifySession((await response.json() as { token: string }).token);
      assert.equal(claims!.at, authDate * 1000);
      assert.equal(isRecentSignIn(claims!), recent, `launch ${age}s ago`);
    }
  } finally {
    restore();
  }
});

/** The signed-in routes, with a session whose Mini App launch was `launchAgeMs` ago. */
function sessionApp(launchAgeMs: number, via: "telegram" | "password" = "telegram") {
  const at = Date.now() - launchAgeMs;
  const app = new Hono();
  app.onError(handleError);
  app.use("*", async (c, next) => {
    // deno-lint-ignore no-explicit-any
    (c as any).set("session", {
      sub: config.ownerId,
      via,
      iat: Date.now() - 1_000,
      at,
      exp: Date.now() + 3_600_000,
      v: 1,
    });
    await next();
  });
  app.route("/", privateAuth);
  return { app, at };
}

Deno.test("password setup needs a recent Telegram launch; /me says whether you have one", async () => {
  try {
    client.from = (table: string) =>
      table === "users"
        ? {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({ data: { password_enabled: false, login_username: null }, error: null }),
            }),
          }),
        }
        : { insert: () => Promise.resolve({ error: null }) };
    client.rpc = () => Promise.resolve({ data: 3, error: null });
    const credentials = { username: "owner", password: "correct-horse-battery-1" };

    const stale = sessionApp(23 * 3600_000).app;
    const refused = await stale.request("/password/setup", json("POST", credentials));
    assert.equal(refused.status, 403);
    assert.match((await refused.json() as { error: string }).error, /open Cloud Drive again from Telegram/);
    assert.equal(
      (await (await stale.request("/me")).json() as { recent_sign_in: boolean }).recent_sign_in,
      false,
    );

    const recent = sessionApp(30_000);
    const ok = await recent.app.request("/password/setup", json("POST", credentials));
    assert.equal(ok.status, 200);
    assert.equal(
      (await (await recent.app.request("/me")).json() as { recent_sign_in: boolean }).recent_sign_in,
      true,
    );
    // the new session keeps the SAME launch time (setting a password does not make the session look newer)
    assert.equal((await verifySession((await ok.json() as { token: string }).token))!.at, recent.at);
  } finally {
    restore();
  }
});

Deno.test("changing credentials: an old Telegram launch must give the current password", async () => {
  try {
    const stored = await hashPassword("old-password-123");
    client.from = (table: string) =>
      table === "users"
        ? {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: {
                    password_enabled: true,
                    login_username: "owner",
                    password_hash: stored.hash,
                    password_salt: stored.salt,
                    password_iterations: stored.iterations,
                  },
                  error: null,
                }),
            }),
          }),
        }
        : {
          delete: () => ({ in: () => Promise.resolve({ error: null }) }),
          insert: () => Promise.resolve({ error: null }),
        };
    client.rpc = (name: string) =>
      Promise.resolve({ data: name === "reserve_login_attempt" ? true : 9, error: null });
    const change = { username: "owner", password: "brand-new-password-9" };

    const stale = sessionApp(23 * 3600_000).app;
    assert.equal((await stale.request("/password", json("PATCH", change))).status, 403); // no current password
    assert.equal(
      (await stale.request("/password", json("PATCH", { ...change, current_password: "wrong-password-1" })))
        .status,
      403,
    );
    assert.equal(
      (await stale.request("/password", json("PATCH", { ...change, current_password: "old-password-123" })))
        .status,
      200,
    );

    const recent = sessionApp(30_000).app; // opened from Telegram a moment ago: no current password needed
    assert.equal((await recent.request("/password", json("PATCH", change))).status, 200);
  } finally {
    restore();
  }
});

// ============================================================ 2. long id lists are sent to the database in groups

Deno.test("batch move / copy / trash: up to 200 ids work and no database request carries more than 100", async () => {
  try {
    const ids = Array.from({ length: 150 }, () => crypto.randomUUID());
    const inSizes: number[] = [];
    let inserted = 0;
    client.from = (table: string) => {
      if (table !== "files") return { insert: () => Promise.resolve({ error: null }) };
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        rows: [] as string[],
        select: () => chain,
        update: () => chain,
        insert: (
          rows: unknown[],
        ) => ((inserted += rows.length), {
          select: () => Promise.resolve({ data: rows.map(() => ({ id: crypto.randomUUID() })), error: null }),
        }),
        in: (_column: string, part: string[]) => (inSizes.push(part.length), (chain.rows = part), chain),
        eq: () => chain,
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({
            data: chain.rows.map((id: string) => ({ id, file_name: "a.png", mime_type: "image/png" })),
            error: null,
          }).then(resolve),
      };
      return chain;
    };
    const app = new Hono();
    app.onError(handleError);
    app.route("/", fileRoutes);
    // move looks the files up and then updates them (2 x 150 ids); copy only looks up; trash only updates
    for (
      const [path, expectedTotal] of [["/files/batch/move", 300], ["/files/batch/copy", 150], [
        "/files/batch/trash",
        150,
      ]] as const
    ) {
      inSizes.length = 0;
      const response = await app.request(path, json("POST", { file_ids: ids }));
      assert.ok(response.status === 200 || response.status === 201, `${path} -> ${response.status}`);
      assert.ok(
        inSizes.every((size) => size <= 100),
        `${path}: no request carries more than 100 ids (${inSizes})`,
      );
      assert.equal(
        inSizes.reduce((sum, size) => sum + size, 0),
        expectedTotal,
        `${path}: every id is covered`,
      );
    }
    assert.equal(inserted, 150); // the copy really covered every file
    const tooMany = await app.request(
      "/files/batch/trash",
      json("POST", { file_ids: Array.from({ length: 201 }, () => crypto.randomUUID()) }),
    );
    assert.equal(tooMany.status, 400);
  } finally {
    restore();
  }
});

// ============================================================ 4. webhook status

Deno.test("recentWebhookError: old delivery errors are history, recent ones are real", () => {
  const now = Date.now();
  const at = (agoMs: number) => Math.floor((now - agoMs) / 1000);
  assert.deepEqual(recentWebhookError({}, now), { message: null, at: null });
  assert.equal(
    recentWebhookError({ last_error_message: "timeout", last_error_date: at(60_000) }, now).message,
    "timeout",
  );
  const old = recentWebhookError({
    last_error_message: "timeout",
    last_error_date: at(WEBHOOK_ERROR_WINDOW_MS + 60_000),
  }, now);
  assert.equal(old.message, null);
  assert.ok(old.at); // the date is still reported
  assert.equal(recentWebhookError({ last_error_message: "x" }, now).message, "x"); // no date: assume it is current
});

Deno.test("/status: an old webhook error no longer keeps the webhook red", async () => {
  const original = {
    me: bot.api.getMe,
    info: bot.api.getWebhookInfo,
    chat: bot.api.getChat,
    member: bot.api.getChatMember,
  };
  try {
    client.from = () => ({ select: () => Promise.resolve({ error: null }) });
    // deno-lint-ignore no-explicit-any
    const api = bot.api as any;
    api.getMe = () => Promise.resolve({ id: 1, username: "ci_bot" });
    api.getChat = () => Promise.resolve({ title: "Storage" });
    api.getChatMember = () => Promise.resolve({ status: "administrator", can_post_messages: true });
    const app = new Hono();
    app.route("/", systemRoutes);
    const status = async (lastErrorAgoMs: number | null) => {
      api.getWebhookInfo = () =>
        Promise.resolve({
          url: "https://x.test/hook",
          pending_update_count: 0,
          ...(lastErrorAgoMs === null ? {} : {
            last_error_message: "Wrong response from the webhook: 500",
            last_error_date: Math.floor((Date.now() - lastErrorAgoMs) / 1000),
          }),
        });
      return (await (await app.request("/status")).json() as {
        webhook: { ok: boolean; last_error: string | null };
      }).webhook;
    };
    assert.equal((await status(null)).ok, true);
    assert.equal((await status(5 * 60_000)).ok, false); // 5 minutes ago: still a problem
    assert.equal((await status(5 * 60_000)).last_error, "Wrong response from the webhook: 500");
    const healed = await status(26 * 3600_000); // yesterday, since fixed
    assert.equal(healed.ok, true);
    assert.equal(healed.last_error, null);
  } finally {
    // deno-lint-ignore no-explicit-any
    const api = bot.api as any;
    api.getMe = original.me;
    api.getWebhookInfo = original.info;
    api.getChat = original.chat;
    api.getChatMember = original.member;
    restore();
  }
});

// ============================================================ 5. share links and database errors

Deno.test("share link: a database failure is an error to retry, never 'no longer valid'", async () => {
  try {
    const replies: string[] = [];
    const ctx = {
      chat: { id: 5 },
      reply: (text: string) => (replies.push(text), Promise.resolve()),
      api: { copyMessage: () => Promise.resolve() },
    };
    // deno-lint-ignore no-explicit-any
    const asContext = ctx as any;
    client.from = () => ({
      select: () => ({
        eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: "boom" } }) }),
      }),
    });
    await assert.rejects(() => deliverShare(asContext, "tok"), /Unable to look up the share link/);
    assert.deepEqual(replies, []);

    // the link exists but loading the file fails
    let call = 0;
    client.from = () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: "boom" } }) }),
          maybeSingle: () =>
            Promise.resolve(
              ++call === 1 ? { data: { file_id: "f" }, error: null } : { data: null, error: null },
            ),
        }),
      }),
    });
    await assert.rejects(() => deliverShare(asContext, "tok"), /Unable to load the shared file/);

    // a really missing link is still reported as such
    client.from = () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
    });
    await deliverShare(asContext, "tok");
    assert.match(replies[0], /no longer valid/);
  } finally {
    restore();
  }
});

// ============================================================ 6. failed channel deletions are retried

/** A fake database for the retry queue: records what is upserted, updated and deleted. */
function queueDb(
  rows: Array<{ chat_id: number; message_id: number; attempts: number }>,
  referenced: Set<number> = new Set(),
) {
  const log = { upserts: [] as unknown[], updates: [] as unknown[], deletes: [] as unknown[] };
  client.from = (table: string) => {
    if (table === "files") {
      const state = { message: 0 };
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select: () => chain,
        eq: (
          column: string,
          value: number,
        ) => (column === "telegram_message_id" && (state.message = value), chain),
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({ count: referenced.has(state.message) ? 1 : 0, error: null }).then(resolve),
      };
      return chain;
    }
    return {
      upsert: (
        row: unknown,
        options: unknown,
      ) => (log.upserts.push({ row, options }), Promise.resolve({ error: null })),
      select: () => ({
        lte: () => ({ order: () => ({ limit: () => Promise.resolve({ data: rows, error: null }) }) }),
      }),
      update: (values: unknown) => ({
        match: (key: unknown) => (log.updates.push({ values, key }), Promise.resolve({ error: null })),
      }),
      delete: () => ({ match: (key: unknown) => (log.deletes.push(key), Promise.resolve({ error: null })) }),
    };
  };
  return log;
}

Deno.test("channel messages that cannot be deleted are remembered, not forgotten", async () => {
  const realDelete = bot.api.deleteMessage;
  try {
    const log = queueDb([]);
    // deno-lint-ignore no-explicit-any
    (bot.api as any).deleteMessage = (_chat: number, message: number) =>
      message === 1
        ? Promise.resolve(true)
        : message === 2
        ? Promise.reject({ description: "Bad Request: message to delete not found" })
        : Promise.reject({ description: "Bad Request: message can't be deleted" });
    const deleted = await deleteChannelMessages([{ tg_chat_id: -100, tg_message_id: 1 }, {
      tg_chat_id: -100,
      tg_message_id: 2,
    }, { tg_chat_id: -100, tg_message_id: 3 }]);
    assert.equal(deleted, 2); // deleted + already gone
    assert.equal(log.upserts.length, 1);
    const queued = log.upserts[0] as {
      row: { chat_id: number; message_id: number; attempts: number };
      options: { onConflict: string };
    };
    assert.deepEqual([queued.row.chat_id, queued.row.message_id, queued.row.attempts], [-100, 3, 1]);
    assert.equal(queued.options.onConflict, "chat_id,message_id");
    assert.equal(messageAlreadyGone({ description: "Bad Request: message to delete not found" }), true);
    assert.equal(messageAlreadyGone(new Error("network")), false);
  } finally {
    bot.api.deleteMessage = realDelete;
    restore();
  }
});

Deno.test("retry job: finishes, counts attempts, gives up after the limit and never deletes a message a file still uses", async () => {
  const realDelete = bot.api.deleteMessage;
  try {
    const tried: number[] = [];
    // deno-lint-ignore no-explicit-any
    (bot.api as any).deleteMessage = (_chat: number, message: number) => {
      tried.push(message);
      return message === 10
        ? Promise.resolve(true)
        : Promise.reject({ description: "Bad Request: message can't be deleted" });
    };
    const log = queueDb(
      [
        { chat_id: -100, message_id: 10, attempts: 1 }, // works now
        { chat_id: -100, message_id: 20, attempts: 1 }, // fails again, tries left
        { chat_id: -100, message_id: 30, attempts: MAX_DELETE_ATTEMPTS - 1 }, // last try fails: give up
        { chat_id: -100, message_id: 40, attempts: 1 }, // a file points at it again: leave the message alone
      ],
      new Set([40]),
    );
    const result = await retryPendingDeletions();
    assert.deepEqual(result, { deleted: 1, gaveUp: 1, processed: 4 });
    assert.deepEqual(tried, [10, 20, 30]); // 40 was never touched
    assert.deepEqual(log.deletes.map((key) => (key as { message_id: number }).message_id).sort(), [
      10,
      30,
      40,
    ]);
    assert.deepEqual(
      log.updates.map((entry) => (entry as { values: { attempts: number } }).values.attempts),
      [2],
    );
  } finally {
    bot.api.deleteMessage = realDelete;
    restore();
  }
});

// ============================================================ minor and additional

Deno.test("maintenance: cleanup failures are logged, and queued deletions are retried", async () => {
  const realError = console.error;
  const logged: string[] = [];
  try {
    console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
    client.rpc = () => Promise.resolve({ data: [], error: null });
    client.from = (table: string) => {
      if (table === "activity_logs") {
        return {
          delete: () => ({ lt: () => Promise.resolve({ count: null, error: { message: "activity boom" } }) }),
        };
      }
      if (table === "login_attempts") {
        return { delete: () => ({ lt: () => Promise.resolve({ error: { message: "attempts boom" } }) }) };
      }
      if (table === "revoked_sessions") {
        return { delete: () => ({ lt: () => Promise.resolve({ error: null }) }) };
      }
      return {
        select: () => ({
          lte: () => ({ order: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }) }),
        }),
      };
    };
    const result = await runMaintenance();
    assert.equal(result.deletedMessages, 0);
    assert.ok(logged.some((line) => line.includes("activity boom")));
    assert.ok(logged.some((line) => line.includes("attempts boom")));
  } finally {
    console.error = realError;
    restore();
  }
});

Deno.test("search text: a typed * can no longer swallow arbitrary text", () => {
  assert.equal(escapeLike("a*b"), "a_b");
  assert.equal(escapeLike("50%_x\\"), "50\\%\\_x\\\\");
  assert.equal(escapeLike("***"), "___");
});

Deno.test("lastPage: never below 1", () => {
  assert.equal(lastPage(0, 8), 1);
  assert.equal(lastPage(8, 8), 1);
  assert.equal(lastPage(9, 8), 2);
  assert.equal(lastPage(100, 8), 13);
});

Deno.test("bot guard: strangers are ignored, but a tapped button is always answered", async () => {
  const guard = ownerGuard(42);
  const calls: string[] = [];
  const make = (from: number | undefined, extra: Record<string, unknown> = {}) => ({
    from: from === undefined ? undefined : { id: from },
    answerCallbackQuery: (
      other?: { text?: string },
    ) => (calls.push(`answer:${other?.text}`), Promise.resolve()),
    ...extra,
  });
  const next = () => (calls.push("next"), Promise.resolve());
  await guard(make(42), next);
  await guard(make(7, { message: { text: "/start share_abc" } }), next); // anyone may open a share link
  await guard(make(7, { message: { text: "/files" } }), next);
  assert.deepEqual(calls, ["next", "next"]);
  await guard(make(7, { callbackQuery: {} }), next);
  assert.deepEqual(calls.slice(2), ["answer:This button is not for you."]);
  const failing = make(7, {
    callbackQuery: {},
    answerCallbackQuery: () => Promise.reject(new Error("too old")),
  });
  await guard(failing, next); // must not throw
});

Deno.test("album status: queued edits that would say the same thing are not sent", async () => {
  const reports = new AlbumReports();
  const edits: string[] = [];
  const edit = (_id: number, text: string) => (edits.push(text), Promise.resolve());
  const [a, b, c] = ["k", "k", "k"].map(() => reports.join("k", () => Promise.resolve(1), edit));
  await Promise.all([a.record("saved"), b.record("saved"), c.record("saved")]);
  assert.equal(new Set(edits).size, edits.length, "no identical edits");
  assert.equal(edits.at(-1), "✅ Album: 3 saved.");
});

Deno.test("files list: no folder_id means the top level (like the folder list); bad ids are 400", async () => {
  try {
    const calls = { is: [] as unknown[][], eq: [] as unknown[][] };
    // deno-lint-ignore no-explicit-any
    const builder: any = {
      select: () => builder,
      order: () => builder,
      range: () => builder,
      ilike: () => builder,
      not: () => builder,
      is: (...args: unknown[]) => (calls.is.push(args), builder),
      eq: (...args: unknown[]) => (calls.eq.push(args), builder),
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: [], count: 0, error: null }).then(resolve),
    };
    client.from = () => builder;
    const app = new Hono();
    app.onError(handleError);
    app.route("/", fileRoutes);
    const folder = crypto.randomUUID();
    const bodyOf = async (query: string) => (await app.request(`/files${query}`)).status;
    assert.equal(await bodyOf(""), 200);
    assert.deepEqual(
      calls.is,
      [["folder_id", null], ["status", "active"] as unknown[]].slice(0, 1).concat(calls.is.slice(1)).slice(
        0,
        calls.is.length,
      ),
    );
    assert.ok(calls.is.some((args) => args[0] === "folder_id" && args[1] === null), "top level");
    calls.is.length = 0;
    calls.eq.length = 0;
    assert.equal(await bodyOf(`?folder_id=${folder}`), 200);
    assert.ok(calls.eq.some((args) => args[0] === "folder_id" && args[1] === folder));
    calls.is.length = 0;
    calls.eq.length = 0;
    assert.equal(await bodyOf("?global=1&q=x"), 200);
    assert.ok(
      !calls.is.some((args) => args[0] === "folder_id") && !calls.eq.some((args) => args[0] === "folder_id"),
      "global search ignores folders",
    );
    assert.equal(await bodyOf("?folder_id=not-a-uuid"), 400);
  } finally {
    restore();
  }
});

Deno.test("rename: a database failure is 503, not 'file not found'", async () => {
  try {
    client.from = () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: "boom" } }) }),
        }),
      }),
    });
    const app = new Hono();
    app.onError(handleError);
    app.route("/", fileRoutes);
    const response = await app.request(`/files/${crypto.randomUUID()}`, json("PATCH", { file_name: "new" }));
    assert.equal(response.status, 503);
  } finally {
    restore();
  }
});

Deno.test("empty Trash reports files and deleted folders", async () => {
  try {
    const logged: unknown[] = [];
    client.from = (table: string) =>
      table === "trashed_folders"
        ? { select: () => Promise.resolve({ count: 4, error: null }) }
        : table === "pending_message_deletions"
        ? {
          select: () => ({
            lte: () => ({ order: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }) }),
          }),
        }
        : { insert: (row: unknown) => (logged.push(row), Promise.resolve({ error: null })) };
    client.rpc = () =>
      Promise.resolve({
        data: [{ tg_chat_id: -1, tg_message_id: 1, orphaned: false }, {
          tg_chat_id: -1,
          tg_message_id: 2,
          orphaned: false,
        }],
        error: null,
      });
    const app = new Hono();
    app.onError(handleError);
    app.route("/", fileRoutes);
    const response = await app.request("/trash/empty", { method: "POST" });
    assert.deepEqual(await response.json(), { ok: true, count: 2, folders: 4 });
    assert.deepEqual((logged[0] as { details: unknown }).details, { count: 2, folders: 4 });
  } finally {
    restore();
  }
});
