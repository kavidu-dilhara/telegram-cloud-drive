import { Bot } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { logError, logWarn, redactSecrets } from "./redact.ts";

export const bot = new Bot(config.botToken);

// Telegram rate-limits bots; the throttler spaces calls out and auto-retry honours 429 "retry after".
bot.api.config.use(apiThrottler());
bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));

let cachedUsername: string | undefined = config.botUsername;

/** Bot username for share links: BOT_USERNAME if set, otherwise asked from Telegram once. */
export async function botUsername(): Promise<string> {
  if (cachedUsername) return cachedUsername;
  const me = await bot.api.getMe();
  if (!me.username) throw new Error("The bot has no username");
  cachedUsername = me.username;
  return cachedUsername;
}

export const shareUrl = async (token: string) => `https://t.me/${await botUsername()}?start=share_${token}`;

export interface ChannelMessage {
  tg_chat_id: number;
  tg_message_id: number;
}

/** After this many failed tries a stored message is given up on (it may be too old for Telegram to delete). */
export const MAX_DELETE_ATTEMPTS = 10;

/** Telegram says the message is already gone: that counts as deleted. */
export function messageAlreadyGone(error: unknown): boolean {
  const description = (error as { description?: unknown } | null)?.description;
  return /message to delete not found/i.test(typeof description === "string" ? description : String(error));
}

async function deleteOne(message: ChannelMessage): Promise<"deleted" | { error: string }> {
  try {
    await bot.api.deleteMessage(Number(message.tg_chat_id), Number(message.tg_message_id));
    return "deleted";
  } catch (error) {
    if (messageAlreadyGone(error)) return "deleted";
    return { error: redactSecrets(String(error)).slice(0, 300) };
  }
}

/**
 * Deletes orphaned messages from the storage channel. The database rows are already gone by now, so a message that
 * cannot be deleted right away is remembered and retried by the maintenance job instead of being forgotten.
 */
export async function deleteChannelMessages(messages: ChannelMessage[]) {
  let deleted = 0;
  for (const message of messages) {
    const outcome = await deleteOne(message);
    if (outcome === "deleted") {
      deleted++;
      continue;
    }
    logWarn(
      "Telegram message was not deleted; it will be retried",
      message.tg_message_id,
      outcome.error,
    );
    const { error } = await db.from("pending_message_deletions").upsert(
      {
        chat_id: Number(message.tg_chat_id),
        message_id: Number(message.tg_message_id),
        attempts: 1,
        last_error: outcome.error,
      },
      { onConflict: "chat_id,message_id", ignoreDuplicates: true },
    );
    if (error) logError("Unable to remember a message for retry", message.tg_message_id, error.message);
  }
  return deleted;
}

/** Minutes to wait before the next try of a message that could not be deleted (grows with every failure). */
const retryDelayMinutes = (attempts: number) => Math.min(attempts * 5, 60);

/**
 * Deletes queued channel messages that are due (oldest first). Returns how many were finished, how many were given
 * up on, and how many were looked at. A message that fails is scheduled for a later try.
 */
export async function retryPendingDeletions(
  limit = 100,
): Promise<{ deleted: number; gaveUp: number; processed: number }> {
  const { data, error } = await db.from("pending_message_deletions").select("chat_id,message_id,attempts")
    .lte("next_try_at", new Date().toISOString()).order("next_try_at").limit(limit);
  if (error) {
    logError("Unable to read pending message deletions", error.message);
    return { deleted: 0, gaveUp: 0, processed: 0 };
  }
  let deleted = 0;
  let gaveUp = 0;
  for (const row of data ?? []) {
    const key = { chat_id: row.chat_id, message_id: row.message_id };
    // Never delete a message that a file still points at.
    const { count, error: usedError } = await db.from("files").select("id", { count: "exact", head: true })
      .eq("telegram_chat_id", row.chat_id).eq("telegram_message_id", row.message_id);
    if (usedError) continue;
    if ((count ?? 0) > 0) {
      await db.from("pending_message_deletions").delete().match(key);
      continue;
    }
    const outcome = await deleteOne({ tg_chat_id: row.chat_id, tg_message_id: row.message_id });
    if (outcome === "deleted") {
      deleted++;
      await db.from("pending_message_deletions").delete().match(key);
    } else if (Number(row.attempts) + 1 >= MAX_DELETE_ATTEMPTS) {
      gaveUp++;
      logError("Giving up on deleting a channel message", row.message_id, outcome.error);
      await db.from("pending_message_deletions").delete().match(key);
    } else {
      const attempts = Number(row.attempts) + 1;
      await db.from("pending_message_deletions").update({
        attempts,
        last_error: outcome.error,
        next_try_at: new Date(Date.now() + retryDelayMinutes(attempts) * 60_000).toISOString(),
      }).match(key);
    }
  }
  return { deleted, gaveUp, processed: (data ?? []).length };
}

let draining = false;

/**
 * Works through the whole queue, one message after another (Telegram allows about 20 per minute in a channel, so a
 * big queue takes a while). Only one drain runs at a time. Safe to call as often as you like.
 */
export async function drainPendingDeletions(
  maxMs = 10 * 60_000,
): Promise<{ deleted: number; gaveUp: number }> {
  if (draining) return { deleted: 0, gaveUp: 0 };
  draining = true;
  const started = Date.now();
  let deleted = 0;
  let gaveUp = 0;
  try {
    while (Date.now() - started < maxMs) {
      const pass = await retryPendingDeletions(25);
      deleted += pass.deleted;
      gaveUp += pass.gaveUp;
      if (pass.processed === 0) break;
    }
  } finally {
    draining = false;
  }
  return { deleted, gaveUp };
}

/** Starts a drain in the background and returns immediately: a request never waits for Telegram. */
export function kickPendingDeletions(): void {
  drainPendingDeletions().catch((error) => logError("Deleting queued channel messages failed", error));
}
