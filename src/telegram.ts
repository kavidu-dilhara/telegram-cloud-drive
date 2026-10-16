import { Bot } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import { config } from "./config.ts";

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

/** Deletes orphaned messages from the storage channel; failures are logged, never fatal. */
export async function deleteChannelMessages(messages: ChannelMessage[]) {
  let deleted = 0;
  for (const message of messages) {
    try {
      await bot.api.deleteMessage(Number(message.tg_chat_id), Number(message.tg_message_id));
      deleted++;
    } catch (error) {
      console.warn("Telegram message was not deleted", message.tg_message_id, String(error));
    }
  }
  return deleted;
}
