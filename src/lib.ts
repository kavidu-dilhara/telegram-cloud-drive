/** Pure helpers with no side effects, shared by routes, the bot and the tests. */

import { isIP } from "node:net";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && uuidPattern.test(value);

/** Parses 1-200 unique UUIDs, or returns null when the input is invalid. */
export function parseIds(input: unknown): string[] | null {
  if (!Array.isArray(input) || input.length < 1 || input.length > 200) return null;
  if (input.some((id) => !isUuid(id))) return null;
  return [...new Set(input as string[])];
}

/** Escapes LIKE wildcards so user text is matched literally. */
export const escapeLike = (value: string) => value.replace(/[\\%_]/g, (character) => `\\${character}`);

export const chunk = <T>(items: T[], size: number): T[][] => {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
};

export interface FolderNode {
  id: string;
  parent_id: string | null;
  name: string;
}

/** The folder itself plus every folder below it. */
export function descendants(id: string, rows: Pick<FolderNode, "id" | "parent_id">[]): Set<string> {
  const result = new Set<string>([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (row.parent_id && result.has(row.parent_id) && !result.has(row.id)) {
        result.add(row.id);
        changed = true;
      }
    }
  }
  return result;
}

/** "/Projects/2026" style label for a folder id. */
export function folderPath(folderId: string | null, folders: FolderNode[]): string {
  const names: string[] = [];
  const visited = new Set<string>();
  let cursor = folderId;
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const folder = folders.find((item) => item.id === cursor);
    if (!folder) break;
    names.unshift(folder.name);
    cursor = folder.parent_id;
  }
  return names.length ? `/${names.join("/")}` : "/";
}

/** Lower-case extension without the dot, or null. */
export function extensionOf(fileName: string): string | null {
  const index = fileName.lastIndexOf(".");
  if (index <= 0 || index === fileName.length - 1) return null;
  const extension = fileName.slice(index + 1).toLowerCase().replace(/[^a-z0-9]/g, "");
  return extension ? extension.slice(0, 12) : null;
}

/**
 * Rename helper: only the base name changes, the stored extension is always kept.
 * A trailing ".ext" typed by the user is not duplicated.
 */
export function renameKeepingExtension(currentName: string, requestedName: string): string | null {
  const requested = requestedName.trim().replace(/[\r\n\0/\\]/g, " ").replace(/\s+/g, " ");
  const extension = extensionOf(currentName);
  let base = requested;
  if (extension && requested.toLowerCase().endsWith(`.${extension}`)) {
    base = requested.slice(0, -(extension.length + 1));
  }
  base = base.trim().replace(/^\.+/, "").trim();
  if (!base) return null;
  const name = extension ? `${base}.${currentName.slice(currentName.lastIndexOf(".") + 1)}` : base;
  return name.length > 255 ? null : name;
}

/** Single-line, length-limited text for messages and logs. */
export const singleLine = (value: unknown, max = 120) =>
  typeof value === "string" ? value.replace(/[\r\n]+/g, " ").trim().slice(0, max) : "";

export const formatSize = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(2)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
};

export const toHex = (bytes: Uint8Array) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(value: string) {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

/** Constant-time comparison of two byte arrays. */
export function timingSafeEqual(left: Uint8Array, right: Uint8Array) {
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export const safeEqualText = (left: string, right: string) => {
  const encoder = new TextEncoder();
  return timingSafeEqual(encoder.encode(left), encoder.encode(right));
};

export function base64UrlEncode(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

export interface ClientIpOptions {
  /** Header the hosting platform sets or overwrites. Leave unset to use the connection address only. */
  header?: "cf-connecting-ip" | "x-forwarded-for";
  /** Trusted proxies that append to X-Forwarded-For (default 1). */
  hops?: number;
}

/**
 * The address used for per-address throttling. Forwarding headers can be forged by the caller, so they are
 * ignored unless `header` says the platform controls them. For X-Forwarded-For the entry added by the
 * outermost trusted proxy is used (counted from the right), never the caller-supplied left-most one.
 * Anything that is not a valid IP address falls back to the connection address.
 */
export function resolveClientIp(
  headers: Headers,
  remoteAddress: string | undefined,
  options: ClientIpOptions = {},
): string {
  const fallback = remoteAddress?.trim().slice(0, 64) || "unknown";
  if (options.header === "cf-connecting-ip") {
    const value = headers.get("cf-connecting-ip")?.trim() ?? "";
    return isIP(value) ? value : fallback;
  }
  if (options.header === "x-forwarded-for") {
    const parts = (headers.get("x-forwarded-for") ?? "").split(",").map((part) => part.trim());
    const value = parts[parts.length - (options.hops ?? 1)] ?? "";
    return isIP(value) ? value : fallback;
  }
  return fallback;
                           }
  
