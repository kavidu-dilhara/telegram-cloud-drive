import { AlbumReports } from "./album.ts";
import { type Context, InlineKeyboard } from "grammy";
import { config } from "./config.ts";
import { allFolders, db, filesByIds, type FolderRow, logAction } from "./db.ts";
import { folderPath, formatSize, isUuid, sha256Hex, singleLine } from "./lib.ts";
import { extractMedia, storeIncoming } from "./storage.ts";
import { bot, shareUrl } from "./telegram.ts";
import { decryptToken } from "./security.ts";

const PAGE_SIZE = 8;

// ------------------------------------------------------------------ guards

/** Only the owner can use the bot; anyone may open a share link (/start share_...). */
bot.use(async (ctx, next) => {
  const isShare = /^\/start(@\w+)?\s+share_/i.test(ctx.message?.text ?? "");
  if (ctx.from?.id !== config.ownerId && !isShare) return;
  await next();
});

const appButton = (label = "Open Cloud Drive") => new InlineKeyboard().webApp(label, config.miniAppUrl);
const firstName = (ctx: Context) => singleLine(ctx.from?.first_name || ctx.from?.username || "there", 40);
const pageNumber = (value: unknown) => Math.max(1, Math.min(1000, Number(value) || 1));

/** Runs a command and turns any failure into a friendly message instead of silence. */
async function guarded(ctx: Context, failure: string, action: () => Promise<void>) {
  try {
    await action();
  } catch (error) {
    console.error(failure, error);
    await ctx.reply(
      `⚠️ ${failure}\n\nPlease try again in a moment. If it keeps happening, open Cloud Drive → Settings to check the live status.`,
      { reply_markup: appButton() },
    ).catch(() => undefined);
  }
}

const show = (ctx: Context, text: string, reply_markup: InlineKeyboard, edit: boolean) =>
  edit ? ctx.editMessageText(text, { reply_markup }) : ctx.reply(text, { reply_markup });

// ------------------------------------------------------------- share links

async function deliverShare(ctx: Context, token: string) {
  const { data: share } = await db.from("shares").select("file_id").eq("token_hash", await sha256Hex(token))
    .maybeSingle();
  if (!share) {
    return void await ctx.reply("🔗 This share link is no longer valid. Ask the sender for a new one.");
  }
  const { data: file } = await db.from("files").select("telegram_chat_id,telegram_message_id,file_name").eq(
    "id",
    share.file_id,
  ).eq("status", "active").maybeSingle();
  if (!file) return void await ctx.reply("📭 The shared file is no longer available.");
  await ctx.api.copyMessage(ctx.chat!.id, Number(file.telegram_chat_id), Number(file.telegram_message_id));
}

// ------------------------------------------------------------- list views

async function filesView(page: number) {
  const from = (page - 1) * PAGE_SIZE;
  const [{ data, error, count }, folders] = await Promise.all([
    db.from("files").select("file_name,file_size,folder_id,created_at", { count: "exact" }).eq(
      "status",
      "active",
    ).order("created_at", { ascending: false }).order("id").range(from, from + PAGE_SIZE - 1),
    allFolders(),
  ]);
  if (error) throw error;
  if (!data?.length && page === 1) {
    return {
      text:
        "📂 Your Cloud Drive is empty.\n\nSend or forward a file to this chat, or open the app to create folders.",
      keyboard: appButton(),
    };
  }
  const lines = (data ?? []).map((file, index) =>
    `${from + index + 1}. ${singleLine(file.file_name, 60)}\n   ${formatSize(Number(file.file_size))} · ${
      folderPath(file.folder_id, folders)
    }`
  );
  const keyboard = new InlineKeyboard();
  if (page > 1) keyboard.text("‹ Previous", `files:${page - 1}`);
  if (from + PAGE_SIZE < (count ?? 0)) keyboard.text("Next ›", `files:${page + 1}`);
  keyboard.row().webApp("Open Cloud Drive", config.miniAppUrl);
  return { text: `📂 Latest files · page ${page}\n\n${lines.join("\n\n")}`, keyboard };
}

async function trashView(page: number) {
  const from = (page - 1) * PAGE_SIZE;
  const { data, error, count } = await db.from("files").select("file_name,file_size,deleted_at", {
    count: "exact",
  }).eq("status", "trashed").is("trash_entry_id", null).order("deleted_at", { ascending: false }).order("id")
    .range(from, from + PAGE_SIZE - 1);
  if (error) throw error;
  // Deleted folders are single items in Trash (their files are inside them); shown on the first page.
  let folderLines: string[] = [];
  if (page === 1) {
    const folders = await db.from("trashed_folders").select("name,file_count,folder_count", {
      count: "exact",
    })
      .order("deleted_at", { ascending: false }).order("id").limit(PAGE_SIZE);
    if (folders.error) throw folders.error;
    const hiddenFolders = (folders.count ?? 0) - (folders.data?.length ?? 0);
    folderLines = (folders.data ?? []).map((folder) => {
      const files = `${folder.file_count} file${folder.file_count === 1 ? "" : "s"}`;
      const subfolders = Number(folder.folder_count) - 1;
      return `📁 ${singleLine(folder.name, 60)} · ${files}${
        subfolders > 0 ? `, ${subfolders} subfolder${subfolders === 1 ? "" : "s"}` : ""
      }`;
    });
    if (hiddenFolders > 0) {
      folderLines.push(
        `…and ${hiddenFolders} more folder${hiddenFolders === 1 ? "" : "s"} (open the app to see them)`,
      );
    }
  }
  if (!data?.length && !folderLines.length && page === 1) {
    return {
      text: "🗑️ Trash is empty.\n\nFiles and folders you delete are kept here for " +
        config.trashRetentionDays +
        " days before they are removed for good.",
      keyboard: appButton("Open Trash"),
    };
  }
  const lines = [
    ...folderLines,
    ...(data ?? []).map((file, index) =>
      `${from + index + 1}. ${singleLine(file.file_name, 60)} · ${formatSize(Number(file.file_size))}`
    ),
  ];
  const keyboard = new InlineKeyboard();
  if (page > 1) keyboard.text("‹ Previous", `trash:${page - 1}`);
  if (from + PAGE_SIZE < (count ?? 0)) keyboard.text("Next ›", `trash:${page + 1}`);
  keyboard.row().webApp("Manage Trash", config.miniAppUrl);
  return {
    text: `🗑️ In Trash · page ${page}\n\n${
      lines.join("\n")
    }\n\nTrash is emptied automatically after ${config.trashRetentionDays} days. Restore files and folders in the app.`,
    keyboard,
  };
}

async function favoritesView(requestedPage = 1) {
  // The database pages and counts only favorites whose file is active, so pages are never short or numbered wrongly.
  const { data, error } = await db.rpc("favorites_page", { p_page: requestedPage, p_size: PAGE_SIZE });
  if (error) throw error;
  const rows = (data ?? []) as Array<
    { o_total: number; o_page: number; o_id: string; o_name: string; o_size: number }
  >;
  const total = Number(rows[0]?.o_total ?? 0);
  const page = Number(rows[0]?.o_page ?? 1);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = (page - 1) * PAGE_SIZE;
  const files = rows.map((row) => ({ id: row.o_id, file_name: row.o_name, file_size: row.o_size }));

  // Every favorite listed on this page gets a button, so each one can be removed from here.
  const keyboard = new InlineKeyboard();
  for (const file of files) {
    keyboard.text(`⭐ ${singleLine(file.file_name, 32)}`, `fav:${file.id}:${page}`).row();
  }
  if (page > 1) keyboard.text("‹ Previous", `favs:${page - 1}`);
  if (page < pages) keyboard.text("Next ›", `favs:${page + 1}`);
  if (pages > 1) keyboard.row();

  // On the first page, recent files that are not starred yet can be added.
  if (page === 1) {
    const { data: recent } = await db.from("files").select("id,file_name").eq("status", "active").order(
      "created_at",
      { ascending: false },
    ).order("id").limit(PAGE_SIZE);
    const recentIds = (recent ?? []).map((file) => file.id as string);
    const { data: starred } = recentIds.length
      ? await db.from("favorites").select("file_id").in("file_id", recentIds)
      : { data: [] };
    const starredIds = new Set((starred ?? []).map((row) => row.file_id));
    for (const file of (recent ?? []).filter((item) => !starredIds.has(item.id)).slice(0, 4)) {
      keyboard.text(`☆ ${singleLine(file.file_name, 32)}`, `fav:${file.id}:1`).row();
    }
  }
  keyboard.webApp("Open Favorites", config.miniAppUrl);

  const list = files.length
    ? files.map((file, index) =>
      `${from + index + 1}. ${singleLine(file.file_name, 60)} · ${formatSize(Number(file.file_size))}`
    ).join("\n")
    : "No favorites yet.";
  const title = pages > 1 ? `⭐ Favorites · page ${page} of ${pages}` : "⭐ Favorites";
  return { text: `${title}\n\n${list}\n\nTap ⭐ to remove a favorite, or ☆ to add a recent file.`, keyboard };
}

async function sharedView() {
  const { data, error } = await db.from("shares").select("id,file_id,share_token_enc").order("created_at", {
    ascending: false,
  }).limit(20);
  if (error) throw error;
  const files = await filesByIds<{ id: string; file_name: string }>(
    (data ?? []).map((share) => share.file_id),
    "id,file_name",
    true,
  );
  const names = new Map(files.map((file) => [file.id, file.file_name]));
  const active = (data ?? []).filter((share) => names.has(share.file_id));
  if (!active.length) {
    return {
      text:
        "🔗 You have no shared files.\n\nOpen the app, choose a file → Share, and send the link to anyone.",
      keyboard: appButton("Open Cloud Drive"),
    };
  }

  const keyboard = new InlineKeyboard();
  const lines: string[] = [];
  for (const [index, share] of active.entries()) {
    const token = await decryptToken(share.share_token_enc);
    lines.push(
      `${index + 1}. ${singleLine(names.get(share.file_id), 60)}\n   ${
        token ? await shareUrl(token) : "(link unavailable - revoke and share again)"
      }`,
    );
    keyboard.text(`Revoke ${index + 1}`, `rv:${share.id}`);
    if ((index + 1) % 3 === 0) keyboard.row();
  }
  keyboard.row().webApp("Manage links", config.miniAppUrl);
  return {
    text: `🔗 Shared files\n\n${
      lines.join("\n\n")
    }\n\nAnyone with a link can receive the file. Revoke a link to stop sharing.`,
    keyboard,
  };
}

// ---------------------------------------------------------------- commands

bot.command("start", async (ctx) => {
  const payload = String(ctx.match ?? "").trim();
  if (payload.startsWith("share_")) {
    return guarded(ctx, "I couldn't open this shared file.", () => deliverShare(ctx, payload.slice(6)));
  }
  await ctx.reply(
    `👋 Welcome, ${
      firstName(ctx)
    }!\n\nThis is your private Cloud Drive.\n\n• Send or forward any file and I'll save it to your secure storage channel.\n• Organise, search and share everything in the app.\n\nType /help to see all commands.`,
    { reply_markup: appButton() },
  );
});

bot.command(
  "app",
  (ctx) =>
    ctx.reply("☁️ Your Cloud Drive is one tap away.", { reply_markup: appButton("Open my Cloud Drive") }),
);

bot.command("help", (ctx) =>
  ctx.reply(
    [
      "☁️ Cloud Drive help",
      "",
      "Save a file: just send or forward it here.",
      "",
      "Commands",
      "/app – open Cloud Drive",
      "/files [page] – latest files",
      "/storage – storage summary",
      "/newfolder /Projects/2026 – create a folder (parents are created automatically)",
      "/trash [page] – files in Trash",
      "/favorite – pick files to star or unstar",
      "/favorites – list favorites",
      "/shared – manage share links",
      "/settings – open settings",
      "/help – show this message",
    ].join("\n"),
    { reply_markup: appButton() },
  ));

bot.command("files", (ctx) =>
  guarded(ctx, "I couldn't load your files.", async () => {
    const view = await filesView(pageNumber(ctx.match));
    await show(ctx, view.text, view.keyboard, false);
  }));

bot.callbackQuery(/^files:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await guarded(ctx, "I couldn't load your files.", async () => {
    const view = await filesView(pageNumber(ctx.match[1]));
    await show(ctx, view.text, view.keyboard, true);
  });
});

bot.command("trash", (ctx) =>
  guarded(ctx, "I couldn't load Trash.", async () => {
    const view = await trashView(pageNumber(ctx.match));
    await show(ctx, view.text, view.keyboard, false);
  }));

bot.callbackQuery(/^trash:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await guarded(ctx, "I couldn't load Trash.", async () => {
    const view = await trashView(pageNumber(ctx.match[1]));
    await show(ctx, view.text, view.keyboard, true);
  });
});

let storageCache: { at: number; text: string } | null = null;
bot.command("storage", (ctx) =>
  guarded(ctx, "I couldn't calculate storage.", async () => {
    if (!storageCache || Date.now() - storageCache.at > 60_000) {
      const { data, error } = await db.rpc("cloud_drive_dashboard").maybeSingle<
        { active_files: number; active_bytes: number; folder_count: number; trash_count: number }
      >();
      if (error || !data) throw error ?? new Error("Dashboard metrics unavailable");
      storageCache = {
        at: Date.now(),
        text: `📊 Your Cloud Drive\n\nFiles: ${Number(data.active_files)}\nFolders: ${
          Number(data.folder_count)
        }\nIn Trash: ${Number(data.trash_count)}\nSpace used: ${
          formatSize(Number(data.active_bytes))
        }\n\nSize is calculated from file details, not from a Telegram quota.`,
      };
    }
    await ctx.reply(storageCache.text, { reply_markup: appButton("Manage storage") });
  }));

bot.command("newfolder", (ctx) =>
  guarded(ctx, "I couldn't create the folder.", async () => {
    const raw = singleLine(ctx.match, 300);
    const segments = raw.replace(/\\/g, "/").split("/").map((part) => part.trim()).filter(Boolean);
    if (segments[0]?.toLowerCase() === "root") segments.shift(); // older "/root/Projects" style still works
    if (!segments.length) {
      return void await ctx.reply(
        "📁 Tell me which folder to create.\n\nExamples:\n/newfolder /Projects\n/newfolder /Projects/2026",
      );
    }
    if (segments.some((name) => name.length > 100)) {
      return void await ctx.reply("Folder names can be up to 100 characters.");
    }

    const folders = await allFolders();
    let parentId: string | null = null;
    let created = 0;
    for (const name of segments) {
      const existing = folders.find((item) =>
        item.parent_id === parentId && item.name.toLowerCase() === name.toLowerCase()
      );
      if (existing) {
        parentId = existing.id;
        continue;
      }
      const inserted = await db.from("folders").insert({ name, parent_id: parentId }).select(
        "id,parent_id,name,created_at,updated_at",
      ).single();
      if (inserted.error) throw inserted.error;
      const row = inserted.data as FolderRow;
      folders.push(row);
      parentId = row.id;
      created++;
    }
    if (created === 0) {
      return void await ctx.reply(`📁 That folder already exists:\n${folderPath(parentId, folders)}`, {
        reply_markup: appButton("Open folders"),
      });
    }
    await logAction("folder_create", undefined, { name: segments.at(-1) });
    await ctx.reply(`✅ Folder ready:\n${folderPath(parentId, folders)}`, {
      reply_markup: appButton("Open folders"),
    });
  }));

bot.command("favorite", (ctx) =>
  guarded(ctx, "I couldn't load your files.", async () => {
    const view = await favoritesView();
    await ctx.reply(view.text, { reply_markup: view.keyboard });
  }));

bot.command("favorites", (ctx) =>
  guarded(ctx, "I couldn't load Favorites.", async () => {
    const view = await favoritesView();
    await ctx.reply(view.text, { reply_markup: view.keyboard });
  }));

bot.callbackQuery(/^favs:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await guarded(ctx, "I couldn't load Favorites.", async () => {
    const view = await favoritesView(pageNumber(ctx.match[1]));
    await show(ctx, view.text, view.keyboard, true);
  });
});

bot.callbackQuery(/^fav:([0-9a-f-]{36})(?::(\d+))?$/i, async (ctx) => {
  const id = ctx.match[1];
  if (!isUuid(id)) return void await ctx.answerCallbackQuery({ text: "Unknown file" });
  await guarded(ctx, "I couldn't update Favorites.", async () => {
    const { data: existing } = await db.from("favorites").select("id").eq("file_id", id).maybeSingle();
    if (existing) {
      const { error } = await db.from("favorites").delete().eq("file_id", id);
      if (error) throw error;
    } else {
      const { error } = await db.from("favorites").upsert({ file_id: id }, { onConflict: "file_id" });
      if (error) throw error;
    }
    await ctx.answerCallbackQuery({ text: existing ? "Removed from Favorites" : "Added to Favorites ⭐" });
    const view = await favoritesView(pageNumber(ctx.match[2]));
    await ctx.editMessageText(view.text, { reply_markup: view.keyboard });
  });
});

bot.command("shared", (ctx) =>
  guarded(ctx, "I couldn't load shared files.", async () => {
    const view = await sharedView();
    await ctx.reply(view.text, { reply_markup: view.keyboard, link_preview_options: { is_disabled: true } });
  }));

bot.callbackQuery(/^rv:([0-9a-f-]{36})$/i, async (ctx) => {
  const id = ctx.match[1];
  await guarded(ctx, "I couldn't revoke that link.", async () => {
    const { data, error } = await db.from("shares").delete().eq("id", id).select("file_id").maybeSingle();
    if (error) throw error;
    if (data) await logAction("share_revoke", data.file_id);
    await ctx.answerCallbackQuery({ text: data ? "Link revoked" : "Link already removed" });
    const view = await sharedView();
    await ctx.editMessageText(view.text, {
      reply_markup: view.keyboard,
      link_preview_options: { is_disabled: true },
    });
  });
});

bot.command(
  "settings",
  (ctx) =>
    ctx.reply(
      "⚙️ Theme, view, sorting, confirmations, incoming folder, account security and live status are in the app.",
      {
        reply_markup: new InlineKeyboard().webApp("Open Settings", `${config.miniAppUrl}?view=settings`),
      },
    ),
);

// ------------------------------------------------------- incoming files

const albums = new AlbumReports();

bot.on("message", async (ctx) => {
  const message = ctx.message;
  if (message.text?.startsWith("/")) {
    return void await ctx.reply("🤔 I don't know that command. Type /help to see what I can do.");
  }
  if (!extractMedia(message)) {
    return void await ctx.reply(
      "📎 Send or forward a file, photo, video, audio or voice message and I'll save it.\n\nType /help for commands.",
    );
  }

  // Albums arrive as several messages that share ONE status message showing how every file went.
  const album = message.media_group_id
    ? albums.join(
      `${message.chat.id}:${message.media_group_id}`,
      async () => (await ctx.reply("⏳ Album received. Saving all files…")).message_id,
      (statusId, text) => ctx.api.editMessageText(ctx.chat.id, statusId, text, { reply_markup: appButton() }),
    )
    : null;
  const status = album ? null : await ctx.reply("⏳ Saving your file…");
  const finish = (text: string, keyboard = appButton()) =>
    status
      ? ctx.api.editMessageText(ctx.chat.id, status.message_id, text, { reply_markup: keyboard })
      : Promise.resolve();

  try {
    const result = await storeIncoming(message);
    if (result.status === "stored") {
      await (album
        ? album.record("saved")
        : finish(`✅ Saved: ${singleLine(result.filename, 80)}\n${formatSize(result.size)}`));
    } else if (result.status === "duplicate") {
      await (album ? album.record(result.inTrash ? "trashed" : "duplicate") : finish(
        result.inTrash
          ? "♻️ This file is already in your Trash. Restore it, or the folder it was in, from the app."
          : "📌 This file is already in your Cloud Drive.",
      ));
    } else {
      await (album ? album.record("empty") : finish("📎 That message has no file I can save."));
    }
  } catch (error) {
    console.error("Unable to store incoming file", error);
    await (album ? album.record("failed") : finish(
      "⚠️ I couldn't save this file. Nothing was lost - please send it again in a moment.",
      new InlineKeyboard(),
    ));
  }
});

void bot.api.setMyCommands([
  { command: "app", description: "Open Cloud Drive" },
  { command: "files", description: "Latest files" },
  { command: "storage", description: "Storage summary" },
  { command: "newfolder", description: "Create a folder, e.g. /Projects/2026" },
  { command: "trash", description: "Files in Trash" },
  { command: "favorite", description: "Star or unstar files" },
  { command: "favorites", description: "List favorites" },
  { command: "shared", description: "Manage share links" },
  { command: "settings", description: "Open settings" },
  { command: "help", description: "Show help" },
]).catch((error) => console.error("Unable to register bot commands", error));

bot.catch((error) => console.error("Bot error", error.error));

export { bot };
