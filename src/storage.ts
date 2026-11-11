import { ServiceUnavailableError } from "./errors.ts";
import type { Message } from "grammy/types";
import { config } from "./config.ts";
import { db, folderExists, getSetting, logAction } from "./db.ts";
import { extensionOf } from "./lib.ts";
import { bot, deleteChannelMessages } from "./telegram.ts";

const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "application/pdf": "pdf",
};

export interface IncomingMedia {
  kind: "document" | "photo" | "video" | "animation" | "audio" | "voice" | "video_note";
  filename: string;
  size: number;
  mime: string;
  fileId: string;
  uniqueId: string;
}

const KIND_EXTENSIONS: Record<string, string> = {
  photo: "jpg",
  video: "mp4",
  animation: "mp4",
  video_note: "mp4",
  audio: "mp3",
  voice: "ogg",
};

/** A name that is safe to store: no path separators or control characters, one line, at most 120 characters. */
const cleanName = (value: unknown): string => {
  if (typeof value !== "string") return "";
  const text = Array.from(value, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 32 || code === 127 || char === "/" || char === "\\" ? " " : char;
  }).join("");
  return text.replace(/\s+/g, " ").trim().slice(0, 120).trim();
};

const pad = (value: number) => String(value).padStart(2, "0");

/** "2026-11-10_14-32-05" (UTC) from a Telegram message date in seconds. */
function stamp(date: number | undefined): string {
  const d = new Date((date ?? Math.floor(Date.now() / 1000)) * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}_${pad(d.getUTCHours())}-${
    pad(d.getUTCMinutes())
  }-${pad(d.getUTCSeconds())}`;
}

/**
 * The best name for an incoming file. Telegram's own file_name always wins. Otherwise: audio tags
 * ("Performer - Title"), then the first line of the caption, then "<kind>_<date>". Photos, voice messages and
 * video notes carry no name at all, so they can only use the caption or the date.
 */
export function pickFilename(
  kind: IncomingMedia["kind"],
  media: Record<string, any>,
  message: { message_id: number; date?: number; caption?: string },
  mime: string,
): string {
  const extension = MIME_EXTENSIONS[mime] ?? KIND_EXTENSIONS[kind];
  const withExtension = (base: string) =>
    !extension || base.toLowerCase().endsWith(`.${extension}`) ? base : `${base}.${extension}`;

  const own = cleanName(media.file_name);
  if (own) return own;

  if (kind === "audio") {
    const tags = [cleanName(media.performer), cleanName(media.title)].filter(Boolean).join(" - ");
    if (tags) return withExtension(tags);
  }
  const caption = cleanName((message.caption ?? "").split(/\r?\n/)[0]);
  if (caption && kind !== "document") return withExtension(caption);

  return withExtension(`${kind}_${stamp(message.date)}`);
}

/** Reads the media (if any) out of a Telegram message. */
export function extractMedia(message: Message): IncomingMedia | null {
  const m = message as Message & Record<string, any>;
  // Telegram sends both `animation` and `document` for GIFs; prefer the more specific one.
  const picked: [IncomingMedia["kind"], any][] = [
    ["animation", m.animation],
    ["document", m.document],
    ["video", m.video],
    ["audio", m.audio],
    ["voice", m.voice],
    ["video_note", m.video_note],
    ["photo", m.photo?.at(-1)],
  ];
  const found = picked.find(([, media]) => media);
  if (!found) return null;
  const [kind, media] = found;
  const mime: string = media.mime_type ??
    (kind === "photo" ? "image/jpeg" : kind === "video_note" ? "video/mp4" : "application/octet-stream");
  return {
    kind,
    filename: pickFilename(kind, media, message, mime),
    size: Number(media.file_size ?? 0),
    mime,
    fileId: media.file_id,
    uniqueId: media.file_unique_id,
  };
}

export type StoreResult =
  | { status: "stored"; filename: string; size: number }
  | { status: "duplicate"; inTrash: boolean }
  | { status: "unsupported" };

/** Messages currently being stored in this isolate, so a webhook redelivery cannot copy twice. */
const inFlight = new Set<string>();

async function incomingFolderId(): Promise<string | null> {
  const value = await getSetting<unknown>("incoming_folder_id");
  if (typeof value !== "string") return null;
  // A deleted folder must never make uploads fail: fall back to the root.
  return (await folderExists(value)) ? value : null;
}

export async function storeIncoming(message: Message): Promise<StoreResult> {
  const item = extractMedia(message);
  if (!item) return { status: "unsupported" };

  const source = { source_chat_id: message.chat.id, source_message_id: message.message_id };
  const key = `${source.source_chat_id}:${source.source_message_id}`;
  if (inFlight.has(key)) return { status: "duplicate", inTrash: false };
  inFlight.add(key);
  try {
    const { data: sameMessage, error: sameMessageError } = await db.from("files").select("id,status").match(
      source,
    )
      .is("copy_of_file_id", null).maybeSingle();
    if (sameMessageError) throw new ServiceUnavailableError("Unable to check for duplicates");
    if (sameMessage) return { status: "duplicate", inTrash: sameMessage.status === "trashed" };

    if (item.uniqueId) {
      const { data: sameContent, error: sameContentError } = await db.from("files").select("id,status").eq(
        "telegram_file_unique_id",
        item.uniqueId,
      ).is("copy_of_file_id", null).limit(1).maybeSingle();
      if (sameContentError) throw new ServiceUnavailableError("Unable to check for duplicates");
      if (sameContent) return { status: "duplicate", inTrash: sameContent.status === "trashed" };
    }

    // Decide where the file goes BEFORE anything is copied: a failed lookup then costs nothing.
    const folderId = await incomingFolderId();
    const copied = await bot.api.copyMessage(config.channelId, message.chat.id, message.message_id, {
      caption: message.caption,
    });
    // From here on, anything that goes wrong must not leave an unreferenced copy in the storage channel.
    // (A copy that cannot be deleted right away is queued and retried.)
    const discardCopy = () =>
      deleteChannelMessages([{ tg_chat_id: config.channelId, tg_message_id: copied.message_id }]);
    let inserted: { id: string } | null;
    let error: { code?: string } | null;
    try {
      ({ data: inserted, error } = await db.from("files").insert({
        folder_id: folderId,
        file_name: item.filename,
        file_size: item.size,
        mime_type: item.mime,
        extension: extensionOf(item.filename),
        media_type: item.kind,
        telegram_chat_id: config.channelId,
        telegram_message_id: copied.message_id,
        telegram_file_id: item.fileId,
        telegram_file_unique_id: item.uniqueId,
        media_group_id: message.media_group_id ?? null,
        caption: message.caption ?? null,
        status: "active",
        ...source,
      }).select("id").single());
    } catch (thrown) {
      await discardCopy();
      throw thrown;
    }
    if (error || !inserted) {
      await discardCopy();
      if (error?.code === "23505") return { status: "duplicate", inTrash: false };
      throw error ?? new Error("The file could not be saved");
    }
    await logAction("upload", inserted.id, { file_name: item.filename, size: item.size });
    return { status: "stored", filename: item.filename, size: item.size };
  } finally {
    inFlight.delete(key);
  }
}
