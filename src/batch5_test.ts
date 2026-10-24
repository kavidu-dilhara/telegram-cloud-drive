import "./test_env.ts";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { Bot } from "grammy";
import { webhookCallback } from "grammy";

Deno.env.set("BOT_USERNAME", "ci_bot");
const { db, folderExists, getSetting } = await import("./db.ts");
const { contentDisposition, intParam, renameKeepingExtension, suffixOf, WEBHOOK_TIMEOUT_MS } = await import(
  "./lib.ts"
);
const { fileRoutes } = await import("./routes/files.ts");
const { publicAuth, privateAuth } = await import("./routes/auth.ts");
const { handleError, ServiceUnavailableError } = await import("./http.ts");
const { config } = await import("./config.ts");
const { storeIncoming } = await import("./storage.ts");
const { bot } = await import("./telegram.ts");
const { answerFailure, editQuietly, isNotModified } = await import("./botErrors.ts");

// deno-lint-ignore no-explicit-any
const client = db as any;
const realFrom = client.from;
const realRpc = client.rpc;
const restore = () => {
  client.from = realFrom;
  client.rpc = realRpc;
};
const FILE = "22222222-2222-4222-8222-2222222222f1";

// ---------------------------------------------------------------- 1. file names in headers

Deno.test("contentDisposition: every file name makes a valid header", () => {
  const names = [
    "ස.png",
    "résumé.pdf",
    "日本語.txt",
    "emoji 😀.png",
    'quote".png',
    "back\\slash.png",
    "100%.png",
    "it's (1)*.png",
    "line\r\nbreak.png",
    "a".repeat(255) + ".png",
    "\ud800broken.png",
    "   ",
    "",
  ];
  for (const name of names) {
    const header = contentDisposition(name);
    new Response("x", { headers: { "Content-Disposition": header } }); // must not throw
    // a plain-ASCII fallback with no quote, backslash, percent sign or line break in it
    assert.match(header, /^inline; filename="[\x20-\x7e]*"(; filename\*=UTF-8''[A-Za-z0-9%._~-]*)?$/);
    assert.doesNotMatch(header.match(/^inline; filename="([^;]*?)"/)![1], /["\\%]/);
    assert.doesNotMatch(header, /[\r\n]/);
  }
  assert.equal(
    contentDisposition("ස.png"),
    `inline; filename="_.png"; filename*=UTF-8''%E0%B7%83.png`,
  );
  assert.match(contentDisposition("it's (1)*.png"), /filename\*=UTF-8''it%27s%20%281%29%2A\.png/);
  assert.equal(
    contentDisposition("a.png", "attachment"),
    `attachment; filename="a.png"; filename*=UTF-8''a.png`,
  );
});

Deno.test("preview: a Sinhala file name no longer breaks the response", async () => {
  const realFetch = globalThis.fetch;
  try {
    client.from = () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({
                data: { telegram_file_id: "tg", file_size: 100, mime_type: "image/png", file_name: "ස.png" },
              }),
          }),
        }),
      }),
    });
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      return Promise.resolve(
        url.includes("/getFile")
          ? new Response(JSON.stringify({ result: { file_path: "photos/a.png" } }))
          : new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Length": "4" } }),
      );
    }) as typeof fetch;
    const app = new Hono();
    app.onError(handleError);
    app.route("/", fileRoutes);
    const response = await app.request(`/files/${FILE}/preview`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Content-Disposition")!, /filename\*=UTF-8''%E0%B7%83\.png/);
    await response.arrayBuffer();
  } finally {
    globalThis.fetch = realFetch;
    restore();
  }
});

// ---------------------------------------------------------------- 2. renaming

Deno.test("rename: the stored extension is kept whatever characters it has", () => {
  assert.equal(suffixOf("photo.жб"), "жб");
  assert.equal(suffixOf("noext"), null);
  assert.equal(suffixOf(".hidden"), null);
  assert.equal(suffixOf("trailing."), null);
  assert.equal(renameKeepingExtension("photo.жб", "holiday"), "holiday.жб"); // was "holiday"
  assert.equal(renameKeepingExtension("a.___", "new"), "new.___");
  assert.equal(renameKeepingExtension("a.中文", "new"), "new.中文");
  assert.equal(renameKeepingExtension("a.c++", "new"), "new.c++");
  assert.equal(renameKeepingExtension("a.abcdefghijklmnopq", "x"), "x.abcdefghijklmnopq");
  // typing the extension yourself does not duplicate it, in any case and for any length
  assert.equal(renameKeepingExtension("a.abcdefghijklmnopq", "x.abcdefghijklmnopq"), "x.abcdefghijklmnopq");
  assert.equal(renameKeepingExtension("a.жб", "holiday.ЖБ"), "holiday.жб");
  assert.equal(renameKeepingExtension("a.PNG", "pic.png"), "pic.PNG");
  assert.equal(renameKeepingExtension("a.png", "pic"), "pic.png");
  assert.equal(renameKeepingExtension("README", "docs"), "docs");
  assert.equal(renameKeepingExtension("a.png", "  .png "), null);
  assert.equal(renameKeepingExtension("a.png", "x".repeat(300)), null);
});

// ---------------------------------------------------------------- 13. numbers in the query string

Deno.test("intParam: whole numbers only, clamped, with a fallback", () => {
  assert.equal(intParam("2.7", 1, 1, 100), 2);
  assert.equal(intParam("0", 1, 1, 100), 1);
  assert.equal(intParam("-5", 1, 1, 100), 1);
  assert.equal(intParam("1e9", 1, 1, 100), 100);
  assert.equal(intParam("abc", 50, 1, 100), 50);
  assert.equal(intParam("", 50, 1, 100), 50);
  assert.equal(intParam(undefined, 50, 1, 100), 50);
  assert.equal(intParam("Infinity", 50, 1, 100), 50);
  assert.equal(intParam(" 7 ", 1, 1, 100), 7);
});

/** A files query that records what the route asked for. */
function listingDb(calls: { ilike: unknown[][]; not: unknown[][]; range: unknown[][] }) {
  // deno-lint-ignore no-explicit-any
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    is: () => builder,
    order: () => builder,
    range: (...args: unknown[]) => (calls.range.push(args), builder),
    ilike: (...args: unknown[]) => (calls.ilike.push(args), builder),
    not: (...args: unknown[]) => (calls.not.push(args), builder),
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ data: [], count: 0, error: null }).then(resolve),
  };
  client.from = () => builder;
}

Deno.test("files list: ?type= only accepts the real types; page and limit are whole numbers", async () => {
  try {
    const calls = { ilike: [] as unknown[][], not: [] as unknown[][], range: [] as unknown[][] };
    listingDb(calls);
    const app = new Hono();
    app.onError(handleError);
    app.route("/", fileRoutes);
    for (const type of ["constructor", "toString", "__proto__", "hasOwnProperty", "nope"]) {
      assert.equal((await app.request(`/files?type=${type}`)).status, 200);
    }
    assert.deepEqual(calls.ilike, [], "no inherited property is ever used as a filter");
    await app.request("/files?type=image");
    assert.deepEqual(calls.ilike, [["mime_type", "image/%"]]);
    await app.request("/files?type=document");
    assert.equal(calls.not.length, 3);

    calls.range.length = 0;
    assert.equal((await app.request("/files?page=2.7&limit=2.5")).status, 200);
    assert.deepEqual(calls.range[0], [2, 3]); // page 2, limit 2 -> rows 2..3, whole numbers only
    calls.range.length = 0;
    await app.request("/files?page=abc&limit=1e9");
    assert.deepEqual(calls.range[0], [0, 99]);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------- 5. webhook timeout

Deno.test("webhook: a slow update is acknowledged (200), not answered with an error that makes Telegram resend", async () => {
  assert.ok(WEBHOOK_TIMEOUT_MS > 10_000);
  const botInfo = {
    id: 1,
    is_bot: true,
    first_name: "t",
    username: "t_bot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
  };
  let finished = false;
  const slow = // deno-lint-ignore no-explicit-any
    new Bot("1:t", { botInfo: botInfo as any });
  slow.on("message", async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    finished = true;
  });
  const update = JSON.stringify({
    update_id: 1,
    message: { message_id: 1, date: 1, chat: { id: 1, type: "private" }, text: "hi" },
  });
  const request = () =>
    new Request("https://x.test/hook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: update,
    });

  const ack = await webhookCallback(slow, "std/http", { onTimeout: "return", timeoutMilliseconds: 50 })(
    request(),
  );
  assert.equal(ack.status, 200);
  assert.equal(finished, false); // answered while the work is still running...
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(finished, true); // ...and it still completes in the background

  // what the old default did: the error answer that makes Telegram send the update again
  await assert.rejects(
    () => webhookCallback(slow, "std/http", { timeoutMilliseconds: 50 })(request()),
    /timed out/,
  );
});

// ---------------------------------------------------------------- 9. bot button errors

Deno.test("bot helpers: 'message is not modified' is not a failure; a failed button is always answered", async () => {
  assert.equal(
    isNotModified({ description: "Bad Request: message is not modified: specified new message content" }),
    true,
  );
  assert.equal(isNotModified(new Error("Bad Request: message is not modified")), true);
  assert.equal(isNotModified({ description: "Bad Request: message to edit not found" }), false);
  assert.equal(isNotModified(null), false);

  await editQuietly(() => Promise.reject({ description: "Bad Request: message is not modified" })); // swallowed
  await assert.rejects(() => editQuietly(() => Promise.reject(new Error("network"))), /network/);

  const answers: unknown[] = [];
  await answerFailure({
    callbackQuery: {},
    answerCallbackQuery: (other) => (answers.push(other), Promise.resolve(true)),
  });
  assert.equal(answers.length, 1);
  await answerFailure({
    callbackQuery: undefined,
    answerCallbackQuery: () => Promise.reject(new Error("must not be called")),
  });
  await answerFailure({
    callbackQuery: {},
    answerCallbackQuery: () => Promise.reject(new Error("already answered")),
  }); // never throws
});

// ---------------------------------------------------------------- 10. Telegram sign-in during an outage

async function signedInitData(userId: number, token = config.botToken) {
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
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: "AAH",
    user: JSON.stringify({ id: userId, first_name: "Owner" }),
  });
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join(
    "\n",
  );
  const secret = await hmac("WebAppData", token);
  const hash = [...new Uint8Array(await hmac(secret, check))].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  params.set("hash", hash);
  return params.toString();
}

Deno.test("Telegram sign-in: bad signature is 401, a database outage is 503 (not 'session out of date')", async () => {
  try {
    const app = new Hono();
    app.onError(handleError);
    app.route("/api/auth", publicAuth);
    const post = (initData: string) =>
      app.request("/api/auth/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData }),
      });

    client.from = () => ({
      upsert: () => Promise.resolve({ error: null }),
      select: () => ({
        eq: () => ({ maybeSingle: () => Promise.resolve({ data: { session_version: 1 }, error: null }) }),
      }),
    });
    const good = await post(await signedInitData(config.ownerId));
    assert.equal(good.status, 200);
    assert.ok((await good.json() as { token: string }).token);

    assert.equal((await post("auth_date=1&hash=" + "0".repeat(64))).status, 401);
    assert.equal((await post(await signedInitData(config.ownerId, "999:other-token"))).status, 401);
    assert.equal((await post(await signedInitData(config.ownerId + 1))).status, 401); // not the owner

    client.from = () => ({
      upsert: () => Promise.resolve({ error: { message: "boom" } }),
      select: () => ({
        eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: "boom" } }) }),
      }),
    });
    const outage = await post(await signedInitData(config.ownerId));
    assert.equal(outage.status, 503);
    assert.equal(outage.headers.get("Retry-After"), "5");
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------- 11. database errors are not swallowed

Deno.test("folderExists / getSetting: a database failure is an error, not 'not found' or 'no value'", async () => {
  try {
    const failing = {
      select: () => ({
        eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: "boom" } }) }),
      }),
    };
    client.from = () => failing;
    await assert.rejects(() => folderExists(FILE), ServiceUnavailableError);
    await assert.rejects(() => getSetting("incoming_folder_id"), ServiceUnavailableError);
    const empty = {
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
    };
    client.from = () => empty;
    assert.equal(await folderExists(FILE), false); // really missing is still just "false"
    assert.equal(await folderExists(null), true);
    assert.equal(await getSetting("x"), undefined);
  } finally {
    restore();
  }
});

Deno.test("API: moving a file during a database outage is 503, not 'destination not found'", async () => {
  try {
    client.from = () => ({
      select: () => ({
        eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: "boom" } }) }),
      }),
    });
    const app = new Hono();
    app.onError(handleError);
    app.route("/", fileRoutes);
    const response = await app.request(`/files/${FILE}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder_id: "33333333-3333-4333-8333-333333333333" }),
    });
    assert.equal(response.status, 503);
  } finally {
    restore();
  }
});

Deno.test("upload: duplicate checks that fail stop the upload (nothing is copied, nothing lands in the wrong folder)", async () => {
  const realCopy = bot.api.copyMessage;
  let copies = 0;
  try {
    // deno-lint-ignore no-explicit-any
    (bot.api as any).copyMessage = () => (copies++, Promise.resolve({ message_id: 9 }));
    const message = {
      message_id: 501,
      chat: { id: 7 },
      date: 1,
      document: {
        file_id: "f",
        file_unique_id: "u",
        file_name: "a.png",
        mime_type: "image/png",
        file_size: 10,
      },
      // deno-lint-ignore no-explicit-any
    } as any;
    // 1) the same-message check fails
    // deno-lint-ignore no-explicit-any
    const chain: any = {
      select: () => chain,
      match: () => chain,
      is: () => chain,
      eq: () => chain,
      limit: () => chain,
      maybeSingle: () => Promise.resolve({ data: null, error: { message: "boom" } }),
    };
    client.from = () => chain;
    await assert.rejects(() => storeIncoming(message), ServiceUnavailableError);
    // 2) the same-content check fails (the first one is fine)
    let calls = 0;
    chain.maybeSingle = () =>
      Promise.resolve(
        ++calls === 1 ? { data: null, error: null } : { data: null, error: { message: "boom" } },
      );
    await assert.rejects(() => storeIncoming({ ...message, message_id: 502 }), ServiceUnavailableError);
    assert.equal(copies, 0);
  } finally {
    bot.api.copyMessage = realCopy;
    restore();
  }
});

// ---------------------------------------------------------------- 12. session changes are atomic

Deno.test("sign out everywhere / credential changes: one atomic database call, and failures are reported", async () => {
  try {
    const calls: Array<{ name: string; args: unknown }> = [];
    client.from = () => ({ insert: () => Promise.resolve({ error: null }) });
    client.rpc = (
      name: string,
      args: unknown,
    ) => (calls.push({ name, args }), Promise.resolve({ data: 5, error: null }));
    const session = new Hono();
    session.onError(handleError);
    session.use("*", async (c, next) => {
      // deno-lint-ignore no-explicit-any
      (c as any).set("session", {
        sub: 42,
        via: "telegram",
        iat: Date.now() - 600_000,
        exp: Date.now() + 3_600_000,
        v: 1,
      });
      await next();
    });
    session.route("/", privateAuth);

    assert.equal((await session.request("/logout-all", { method: "POST" })).status, 200);
    assert.deepEqual(calls[0], { name: "bump_session_version", args: { p_telegram_id: config.ownerId } });

    client.rpc = () => Promise.resolve({ data: null, error: { message: "boom" } });
    assert.equal((await session.request("/logout-all", { method: "POST" })).status, 503); // never "success" without a change

    // password setup: the owner row exists but browser sign-in is not on yet
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
    const setup = (body: unknown) =>
      session.request("/password/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const credentials = { username: "owner", password: "correct-horse-battery-1" };
    client.rpc = (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return Promise.resolve({ data: 7, error: null });
    };
    const ok = await setup(credentials);
    assert.equal(ok.status, 200);
    assert.ok((await ok.json() as { token: string }).token);
    const saved = calls.at(-1)!;
    assert.equal(saved.name, "set_owner_credentials");
    assert.equal((saved.args as { p_username: string }).p_username, "owner");
    assert.equal((saved.args as { p_iterations: number }).p_iterations, 600_000);

    client.rpc = () => Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key" } });
    assert.equal((await setup(credentials)).status, 409);
    client.rpc = () => Promise.resolve({ data: null, error: { code: "XX000", message: "boom" } });
    assert.equal((await setup(credentials)).status, 500);
  } finally {
    restore();
  }
});
