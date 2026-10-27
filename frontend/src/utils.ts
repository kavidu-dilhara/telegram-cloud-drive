import type { FileRow, FolderRow } from "./types";

export const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

export { formatSize } from "./format";

export const formatDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export const PREVIEW_LIMIT = 2 * 1024 * 1024;
// Raster formats only: SVG can carry script, so the server refuses to preview it.
const PREVIEW_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"];
export const canPreview = (file: FileRow) =>
  PREVIEW_TYPES.includes((file.mime_type ?? "").split(";")[0].trim().toLowerCase()) &&
  Number(file.file_size) < PREVIEW_LIMIT;

/** Whole days left before a trashed file is removed automatically. */
export function daysLeft(deletedAt: string | null, retentionDays: number): number {
  if (!deletedAt) return retentionDays;
  const remaining = new Date(deletedAt).getTime() + retentionDays * 86_400_000 - Date.now();
  return Math.max(0, Math.ceil(remaining / 86_400_000));
}

export function extensionOf(name: string): string {
  const index = name.lastIndexOf(".");
  return index > 0 && index < name.length - 1 ? name.slice(index) : "";
}

/** Splits "report.pdf" into the editable base name and the extension that is always kept. */
export function splitName(name: string): { base: string; ext: string } {
  const ext = extensionOf(name);
  return { base: ext ? name.slice(0, -ext.length) : name, ext };
}

export function descendants(id: string, folders: FolderRow[]): Set<string> {
  const result = new Set<string>([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of folders) {
      if (folder.parent_id && result.has(folder.parent_id) && !result.has(folder.id)) {
        result.add(folder.id);
        changed = true;
      }
    }
  }
  return result;
}

export function folderPath(id: string | null, folders: FolderRow[]): string {
  const names: string[] = [];
  const seen = new Set<string>();
  let cursor = id;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const folder = folders.find((item) => item.id === cursor);
    if (!folder) break;
    names.unshift(folder.name);
    cursor = folder.parent_id;
  }
  return names.length ? names.join(" / ") : "My files";
}

export interface FolderOption {
  id: string | null;
  label: string;
}

/** Destination choices with full paths, so two folders called "2026" are never ambiguous. */
export function folderOptions(folders: FolderRow[], exclude: Set<string> = new Set()): FolderOption[] {
  const options = folders
    .filter((folder) => !exclude.has(folder.id))
    .map((folder) => ({
      id: folder.id as string | null,
      label: `My files / ${folderPath(folder.id, folders)}`,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" }));
  return [{ id: null, label: "My files (top level)" }, ...options];
}

const ACTION_LABELS: Record<string, string> = {
  upload: "File saved",
  trash: "Moved to Trash",
  restore: "Restored from Trash",
  permanent_delete: "Deleted permanently",
  trash_empty: "Trash emptied",
  file_rename: "File renamed",
  file_move: "Moved",
  file_copy: "Copied",
  favorite_add: "Added to Favorites",
  favorite_remove: "Removed from Favorites",
  share_create: "Share link created",
  share_revoke: "Share link revoked",
  folder_create: "Folder created",
  folder_rename: "Folder renamed",
  folder_move: "Folder moved",
  folder_copy: "Folder copied",
  folder_delete: "Folder moved to Trash",
  folder_restore: "Folder restored from Trash",
  folder_permanent_delete: "Folder deleted permanently",
  settings_update: "Settings changed",
  sign_in: "Signed in with password",
  sign_out_everywhere: "Signed out everywhere",
  password_setup: "Browser sign-in enabled",
  password_change: "Credentials changed",
};

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** Splits a list into groups of at most `size` items. */
export const chunk = <T,>(items: T[], size: number): T[][] => {
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size) groups.push(items.slice(index, index + size));
  return groups;
};
