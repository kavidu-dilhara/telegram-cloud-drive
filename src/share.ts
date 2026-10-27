import type { Context } from "grammy";
import { db } from "./db.ts";
import { ServiceUnavailableError } from "./errors.ts";
import { sha256Hex } from "./lib.ts";

/** Sends the shared file to whoever opened the link. A database problem is an error (retry), never "invalid link". */
export async function deliverShare(ctx: Context, token: string) {
  const { data: share, error: shareError } = await db.from("shares").select("file_id")
    .eq("token_hash", await sha256Hex(token)).maybeSingle();
  if (shareError) throw new ServiceUnavailableError("Unable to look up the share link");
  if (!share) {
    return void await ctx.reply("🔗 This share link is no longer valid. Ask the sender for a new one.");
  }
  const { data: file, error: fileError } = await db.from("files").select(
    "telegram_chat_id,telegram_message_id,file_name",
  ).eq("id", share.file_id).eq("status", "active").maybeSingle();
  if (fileError) throw new ServiceUnavailableError("Unable to load the shared file");
  if (!file) return void await ctx.reply("📭 The shared file is no longer available.");
  await ctx.api.copyMessage(ctx.chat!.id, Number(file.telegram_chat_id), Number(file.telegram_message_id));
}
