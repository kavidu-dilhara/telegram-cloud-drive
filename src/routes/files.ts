import { Hono } from "hono";
import { config } from "../config.ts";
import {
  COPYABLE_FILE_COLUMNS,
  db,
  filesByIds,
  folderExists,
  logAction,
  PUBLIC_FILE_COLUMNS,
} from "../db.ts";
import { type AppEnv, type Ctx, fail, jsonBody } from "../http.ts";
import { escapeLike, isUuid, parseIds, previewImageType, renameKeepingExtension } from "../lib.ts";
import { purgeTrash } from "../maintenance.ts";
import { type ChannelMessage, deleteChannelMessages } from "../telegram.ts";

export const fileRoutes = new Hono<AppEnv>();

const PREVIEW_LIMIT = 2 * 1024 * 1024;
const TYPE_PREFIX: Record<string, string> = { image: "image/%", video: "video/%", audio: "audio/%" };
const now = () => new Date().toISOString();

// ------------------------------------------------------------------- listing

fileRoutes.get("/files", async (c) => {
  const search = (c.req.query("q") ?? "").trim().slice(0, 100);
  const folderId = c.req.query("folder_id");
  const type = c.req.query("type")?.trim().toLowerCase();
  const extension = c.req.query("extension")?.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const page = Math.max(1, Math.min(100000, Number(c.req.query("page") ?? "1") || 1));
  const limit = Math.max(1, Math.min(100, Number(c.req.query("limit") ?? "50") || 50));
  const sortKey = c.req.query("sort");
  const sort = sortKey === "name" ? "file_name" : sortKey === "size" ? "file_size" : "created_at";
  const ascending = c.req.query("direction") === "asc";
  if (folderId !== undefined && folderId !== "root" && !isUuid(folderId)) return fail(c, "Invalid folder id");

  let query = db.from("files").select(PUBLIC_FILE_COLUMNS, { count: "exact" })
    .eq("status", "active")
    .order(sort, { ascending })
    .order("id") // stable tiebreaker so pages never repeat or skip rows
    .range((page - 1) * limit, page * limit - 1);

  if (c.req.query("global") !== "1") {
    if (folderId === "root") query = query.is("folder_id", null);
    else if (folderId) query = query.eq("folder_id", folderId);
  }
  if (search) query = query.ilike("file_name", `%${escapeLike(search)}%`);
  if (type && TYPE_PREFIX[type]) query = query.ilike("mime_type", TYPE_PREFIX[type]);
  if (type === "document") {
    query = query.not("mime_type", "ilike", TYPE_PREFIX.image).not("mime_type", "ilike", TYPE_PREFIX.video)
      .not("mime_type", "ilike", TYPE_PREFIX.audio);
  }
  if (extension) query = query.eq("extension", extension);

  const { data, error, count } = await query;
  if (error) return fail(c, "Unable to load files", 500);
  return c.json({ items: data ?? [], page, limit, total: count ?? 0, has_more: page * limit < (count ?? 0) });
});

// ----------------------------------------------------------- rename / move

fileRoutes.patch("/files/:id", async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return fail(c, "Invalid file id");
  const body = await jsonBody<{ file_name?: unknown; folder_id?: unknown }>(c);
  if (!body) return fail(c, "Invalid JSON body");
  const update: Record<string, unknown> = {};

  if (body.file_name !== undefined) {
    if (typeof body.file_name !== "string") return fail(c, "Invalid file name");
    const { data: current } = await db.from("files").select("file_name").eq("id", id).eq("status", "active")
      .maybeSingle();
    if (!current) return fail(c, "File not found", 404);
    // Only the name changes: the original extension is always kept.
    const name = renameKeepingExtension(current.file_name, body.file_name);
    if (!name) return fail(c, "File name must be 1-255 characters");
    update.file_name = name;
  }
  if (body.folder_id !== undefined) {
    if (body.folder_id !== null && (!isUuid(body.folder_id) || !await folderExists(body.folder_id))) {
      return fail(c, "Invalid destination folder");
    }
    update.folder_id = body.folder_id;
  }
  if (!Object.keys(update).length) return fail(c, "No changes supplied");
  update.updated_at = now();

  const { data, error } = await db.from("files").update(update).eq("id", id).eq("status", "active").select(
    PUBLIC_FILE_COLUMNS,
  ).maybeSingle();
  if (error) return fail(c, "Unable to update file", 500);
  if (!data) return fail(c, "File not found", 404);
  await logAction(update.file_name ? "file_rename" : "file_move", id, { file_name: data.file_name });
  return c.json(data);
});

async function moveOrCopy(c: Ctx, copy: boolean, suppliedIds?: string[], suppliedFolder?: string | null) {
  const body = suppliedIds ? null : await jsonBody<{ file_ids?: unknown; folder_id?: unknown }>(c);
  const ids = suppliedIds ?? parseIds(body?.file_ids);
  const folderId = suppliedFolder !== undefined
    ? suppliedFolder
    : body?.folder_id === undefined
    ? null
    : body.folder_id;
  if (!ids) return fail(c, "file_ids must contain 1-200 valid ids");
  if (folderId !== null && (!isUuid(folderId) || !await folderExists(folderId as string))) {
    return fail(c, "Invalid destination folder");
  }

  const { data: files, error } = await db.from("files").select(`id,${COPYABLE_FILE_COLUMNS}`).in("id", ids)
    .eq("status", "active");
  if (error || !files || files.length !== ids.length) return fail(c, "One or more files were not found", 404);

  if (copy) {
    const rows = files.map(({ id, ...rest }) => ({
      ...rest,
      copy_of_file_id: id,
      folder_id: folderId,
      status: "active",
    }));
    const { data, error: insertError } = await db.from("files").insert(rows).select("id");
    if (insertError) return fail(c, "Unable to copy files", 500);
    await logAction("file_copy", undefined, { count: ids.length, folder_id: folderId });
    return c.json({ ok: true, ids: data?.map((row) => row.id) ?? [] }, 201);
  }
  const { error: updateError } = await db.from("files").update({ folder_id: folderId, updated_at: now() }).in(
    "id",
    ids,
  ).eq("status", "active");
  if (updateError) return fail(c, "Unable to move files", 500);
  await logAction("file_move", undefined, { count: ids.length, folder_id: folderId });
  return c.json({ ok: true });
}

fileRoutes.post("/files/batch/move", (c) => moveOrCopy(c, false));
fileRoutes.post("/files/batch/copy", (c) => moveOrCopy(c, true));
fileRoutes.post("/files/:id/copy", async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return fail(c, "Invalid file id");
  const body = await jsonBody<{ folder_id?: unknown }>(c);
  return moveOrCopy(c, true, [id], (body?.folder_id ?? null) as string | null);
});

// ------------------------------------------------------------- trash

function setTrashed(ids: string[], trashed: boolean) {
  const patch = trashed
    ? { status: "trashed", deleted_at: now(), updated_at: now() }
    : { status: "active", deleted_at: null, updated_at: now() };
  return db.from("files").update(patch).in("id", ids).eq("status", trashed ? "active" : "trashed").select(
    "id,file_name",
  );
}

fileRoutes.delete("/files/:id", async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return fail(c, "Invalid file id");
  const { data, error } = await setTrashed([id], true);
  if (error) return fail(c, "Unable to move file to trash", 500);
  if (!data?.length) return fail(c, "File not found", 404);
  await logAction("trash", id, { file_name: data[0].file_name });
  return c.json({ ok: true });
});

fileRoutes.post("/files/batch/trash", async (c) => {
  const ids = parseIds((await jsonBody<{ file_ids?: unknown }>(c))?.file_ids);
  if (!ids) return fail(c, "file_ids must contain 1-200 valid ids");
  const { data, error } = await setTrashed(ids, true);
  if (error) return fail(c, "Unable to trash files", 500);
  await logAction("trash", undefined, { count: data?.length ?? 0 });
  return c.json({ ok: true, count: data?.length ?? 0 });
});

fileRoutes.post("/files/batch/restore", async (c) => {
  const ids = parseIds((await jsonBody<{ file_ids?: unknown }>(c))?.file_ids);
  if (!ids) return fail(c, "file_ids must contain 1-200 valid ids");
  const { data, error } = await setTrashed(ids, false);
  if (error) return fail(c, "Unable to restore files", 500);
  await logAction("restore", undefined, { count: data?.length ?? 0 });
  return c.json({ ok: true, count: data?.length ?? 0 });
});

fileRoutes.get("/trash", async (c) => {
  const page = Math.max(1, Math.min(100000, Number(c.req.query("page") ?? "1") || 1));
  const limit = Math.max(1, Math.min(100, Number(c.req.query("limit") ?? "50") || 50));
  const { data, error, count } = await db.from("files").select(PUBLIC_FILE_COLUMNS, { count: "exact" })
    .eq("status", "trashed").order("deleted_at", { ascending: false }).order("id").range(
      (page - 1) * limit,
      page * limit - 1,
    );
  if (error) return fail(c, "Unable to load trash", 500);
  return c.json({
    items: data ?? [],
    page,
    limit,
    total: count ?? 0,
    has_more: page * limit < (count ?? 0),
    retention_days: config.trashRetentionDays,
  });
});

fileRoutes.post("/trash/:id/restore", async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return fail(c, "Invalid file id");
  const { data, error } = await setTrashed([id], false);
  if (error) return fail(c, "Unable to restore file", 500);
  if (!data?.length) return fail(c, "File not found in trash", 404);
  await logAction("restore", id, { file_name: data[0].file_name });
  return c.json({ ok: true });
});

fileRoutes.delete("/files/:id/permanent", async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return fail(c, "Invalid file id");
  const { data: file } = await db.from("files").select("file_name,status").eq("id", id).maybeSingle();
  if (!file) return fail(c, "File not found", 404);
  if (file.status !== "trashed") return fail(c, "Move the file to Trash before deleting it permanently", 409);
  const { data, error } = await db.rpc("purge_file", { p_id: id });
  if (error) return fail(c, "Unable to permanently delete file", 500);
  const rows = (data ?? []) as Array<ChannelMessage & { orphaned: boolean }>;
  await deleteChannelMessages(rows.filter((row) => row.orphaned));
  await logAction("permanent_delete", undefined, { file_name: file.file_name });
  return c.json({ ok: true });
});

fileRoutes.post("/trash/empty", async (c) => {
  try {
    const { purged } = await purgeTrash(null);
    await logAction("trash_empty", undefined, { count: purged });
    return c.json({ ok: true, count: purged });
  } catch (error) {
    console.error("Empty trash failed", error);
    return fail(c, "Unable to empty trash", 500);
  }
});

// ------------------------------------------------------------ favorites

fileRoutes.get("/favorites", async (c) => {
  const { data: favorites, error } = await db.from("favorites").select("id,file_id,created_at").order(
    "created_at",
    { ascending: false },
  ).limit(500);
  if (error) return fail(c, "Unable to load favorites", 500);
  const files = await filesByIds((favorites ?? []).map((item) => item.file_id), PUBLIC_FILE_COLUMNS, true);
  const byId = new Map(files.map((file) => [file.id, file]));
  return c.json(
    (favorites ?? []).map((favorite) => ({ ...favorite, file: byId.get(favorite.file_id) ?? null })).filter((
      item,
    ) => item.file),
  );
});

fileRoutes.post("/files/:id/favorite", async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return fail(c, "Invalid file id");
  const { data: file } = await db.from("files").select("id,file_name").eq("id", id).eq("status", "active")
    .maybeSingle();
  if (!file) return fail(c, "File not found", 404);
  const { error } = await db.from("favorites").upsert({ file_id: id }, { onConflict: "file_id" });
  if (error) return fail(c, "Unable to favorite file", 500);
  await logAction("favorite_add", id, { file_name: file.file_name });
  return c.json({ ok: true });
});

fileRoutes.delete("/files/:id/favorite", async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return fail(c, "Invalid file id");
  const { error } = await db.from("favorites").delete().eq("file_id", id);
  if (error) return fail(c, "Unable to remove favorite", 500);
  await logAction("favorite_remove", id);
  return c.json({ ok: true });
});

// --------------------------------------------------------- image preview

fileRoutes.get("/files/:id/preview", async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return fail(c, "Invalid file id");
  const { data: file } = await db.from("files").select("telegram_file_id,file_size,mime_type,file_name").eq(
    "id",
    id,
  ).eq("status", "active").maybeSingle();
  if (!file) return fail(c, "File not found", 404);
  const mime = previewImageType(file.mime_type);
  if (!mime) return fail(c, "Only PNG, JPEG, GIF and WebP images can be previewed", 415);
  if (Number(file.file_size ?? 0) >= PREVIEW_LIMIT) {
    return fail(c, "Image preview is limited to files under 2 MB", 413);
  }

  const info = await fetch(
    `https://api.telegram.org/bot${config.botToken}/getFile?file_id=${
      encodeURIComponent(file.telegram_file_id)
    }`,
  );
  if (!info.ok) return fail(c, "Unable to prepare image preview", 502);
  const filePath = (await info.json())?.result?.file_path;
  if (typeof filePath !== "string") return fail(c, "Image preview is unavailable", 404);
  const image = await fetch(`https://api.telegram.org/file/bot${config.botToken}/${filePath}`);
  if (!image.ok || !image.body) return fail(c, "Unable to load image preview", 502);

  const headers: Record<string, string> = {
    "Content-Type": mime,
    "Content-Disposition": `inline; filename="${String(file.file_name).replace(/[\r\n"\\]/g, "_")}"`,
    "Cache-Control": "private, max-age=300",
    "X-Content-Type-Options": "nosniff",
    // Defence in depth: even if this URL is opened as a page, nothing in it may run or load.
    "Content-Security-Policy": "default-src 'none'; sandbox",
  };
  const length = image.headers.get("Content-Length");
  if (length) headers["Content-Length"] = length;
  return new Response(image.body, { headers });
});
