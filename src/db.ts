import { ServiceUnavailableError } from "./errors.ts";
import { createClient } from "@supabase/supabase-js";
import { config } from "./config.ts";

export const db = createClient(config.supabaseUrl, config.supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export async function logAction(action: string, fileId?: string, details: Record<string, unknown> = {}) {
  const { error } = await db.from("activity_logs").insert({ action, file_id: fileId ?? null, details });
  if (error) console.error("Activity log failed", { action, fileId, error: error.message });
}

/** PostgREST error with an optional Postgres code. */
export type DbError = { code?: string; message: string } | null;

export interface FolderRow {
  id: string;
  parent_id: string | null;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface FileRow {
  id: string;
  file_name: string;
  file_size: number;
  mime_type: string | null;
  media_type: string;
  extension: string | null;
  folder_id: string | null;
  status: "active" | "trashed";
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  telegram_chat_id: number;
  telegram_message_id: number;
  telegram_file_id: string;
  telegram_file_unique_id: string | null;
  source_chat_id: number;
  source_message_id: number;
  media_group_id: string | null;
  caption: string | null;
  copy_of_file_id: string | null;
}

/** Columns the browser is allowed to see. */
export const PUBLIC_FILE_COLUMNS =
  "id,file_name,file_size,mime_type,media_type,extension,folder_id,status,created_at,updated_at,deleted_at";

/** Columns copied when a file is duplicated (a copy shares the same Telegram message). */
export const COPYABLE_FILE_COLUMNS =
  "file_name,file_size,mime_type,extension,media_type,telegram_chat_id,telegram_message_id,telegram_file_id,telegram_file_unique_id,source_chat_id,source_message_id,media_group_id,caption";

/** Loads files by id in chunks so long id lists never overflow the request URL. */
export async function filesByIds<T = Partial<FileRow>>(
  ids: string[],
  columns = PUBLIC_FILE_COLUMNS,
  onlyActive = false,
): Promise<T[]> {
  const result: T[] = [];
  for (let index = 0; index < ids.length; index += 100) {
    let query = db.from("files").select(columns).in("id", ids.slice(index, index + 100));
    if (onlyActive) query = query.eq("status", "active");
    const { data, error } = await query;
    if (error) throw error;
    result.push(...((data ?? []) as unknown as T[]));
  }
  return result;
}

/** Every folder, fetched page by page because Supabase caps a response at 1000 rows. */
export async function allFolders(): Promise<FolderRow[]> {
  const rows: FolderRow[] = [];
  for (let from = 0;; from += 1000) {
    const { data, error } = await db.from("folders").select("id,parent_id,name,created_at,updated_at").order(
      "name",
    ).order("id").range(from, from + 999);
    if (error) throw error;
    rows.push(...((data ?? []) as FolderRow[]));
    if (!data || data.length < 1000) return rows;
  }
}

/** True when the folder exists. A database failure throws, so it is never mistaken for "folder not found". */
export async function folderExists(id: string | null | undefined) {
  if (id === null || id === undefined) return true;
  const { data, error } = await db.from("folders").select("id").eq("id", id).maybeSingle();
  if (error) {
    console.error("Unable to check a folder", error.message);
    throw new ServiceUnavailableError("Unable to check the folder");
  }
  return !!data;
}

export async function getSetting<T>(key: string): Promise<T | undefined> {
  const { data, error } = await db.from("settings").select("value").eq("key", key).maybeSingle();
  if (error) {
    console.error("Unable to read a setting", key, error.message);
    throw new ServiceUnavailableError("Unable to read settings");
  }
  return data?.value as T | undefined;
}
