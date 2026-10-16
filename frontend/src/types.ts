export type Page = "files" | "favorites" | "shares" | "trash" | "activity" | "settings";

export interface FolderRow {
  id: string;
  parent_id: string | null;
  name: string;
  created_at: string;
  updated_at?: string;
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
  deleted_at: string | null;
}

export interface Paged<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  has_more: boolean;
}

export interface TrashPage extends Paged<FileRow> {
  retention_days: number;
}

export interface Settings {
  theme: "system" | "light" | "dark";
  compact_mode: boolean;
  default_sort: "newest" | "oldest" | "name" | "size";
  default_view: "list" | "grid";
  confirm_delete: boolean;
  confirm_move: boolean;
  incoming_folder_id: string | null;
}

export interface SessionInfo {
  authenticated: true;
  via: "telegram" | "password";
  password_enabled: boolean;
  username: string | null;
  can_change_without_current_password: boolean;
  session_expires_at: string;
}

export interface Dashboard {
  count: number;
  bytes: number;
  folderCount: number;
  trashCount: number;
  trashRetentionDays: number;
}

export interface FavoriteRow {
  id: string;
  file_id: string;
  file: FileRow;
}

export interface ShareRow {
  id: string;
  file_id: string;
  url: string | null;
  file: { id: string; file_name: string; file_size: number };
}

export interface ActivityRow {
  id: string;
  action: string;
  file_name: string | null;
  details: Record<string, unknown>;
  created_at: string;
}

export interface StatusReport {
  checked_at: string;
  backend: { ok: boolean; version: string; region: string | null; deployment: string | null };
  database: { ok: boolean; latency_ms: number; error?: string };
  telegram: { ok: boolean; latency_ms: number; bot_username?: string | null; error?: string };
  webhook: {
    ok: boolean;
    url_set?: boolean;
    pending_updates?: number;
    callbacks_allowed?: boolean;
    last_error?: string | null;
    error?: string;
  };
  channel: { ok: boolean; title?: string | null; bot_role?: string; can_post?: boolean; error?: string };
  retention: { trash_days: number; activity_days: number };
}

declare const __APP_VERSION__: string;
export const APP_VERSION = __APP_VERSION__;
