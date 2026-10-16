import { Hono } from "hono";
import { allFolders, db, folderExists, logAction } from "../db.ts";
import { type AppEnv, fail, jsonBody } from "../http.ts";
import { descendants, isUuid } from "../lib.ts";

export const folderRoutes = new Hono<AppEnv>();

const FOLDER_COLUMNS = "id,parent_id,name,created_at,updated_at";
const cleanName = (
  value: unknown,
) => (typeof value === "string" ? value.trim().replace(/[\r\n\0/\\]/g, " ").replace(/\s+/g, " ") : "");
const nameError = "Folder name must be 1-100 characters and cannot contain / or \\";
const duplicateError = "A folder with this name already exists here";

folderRoutes.get("/folders", async (c) => {
  try {
    if (c.req.query("all") === "1") return c.json(await allFolders());
    const parent = c.req.query("parent_id");
    if (parent !== undefined && parent !== "root" && parent !== "" && !isUuid(parent)) {
      return fail(c, "Invalid parent folder");
    }
    let query = db.from("folders").select(FOLDER_COLUMNS).order("name").order("id");
    query = !parent || parent === "root" ? query.is("parent_id", null) : query.eq("parent_id", parent);
    const { data, error } = await query;
    if (error) return fail(c, "Unable to load folders", 500);
    return c.json(data ?? []);
  } catch {
    return fail(c, "Unable to load folders", 500);
  }
});

folderRoutes.post("/folders", async (c) => {
  const body = await jsonBody<{ name?: unknown; parent_id?: unknown }>(c);
  const name = cleanName(body?.name);
  const parentId = body?.parent_id === undefined ? null : body.parent_id;
  if (!name || name.length > 100) return fail(c, nameError);
  if (parentId !== null && (!isUuid(parentId) || !await folderExists(parentId))) {
    return fail(c, "Invalid parent folder");
  }
  const { data, error } = await db.from("folders").insert({ name, parent_id: parentId }).select(
    FOLDER_COLUMNS,
  ).single();
  if (error) {
    return fail(
      c,
      error.code === "23505" ? duplicateError : "Unable to create folder",
      error.code === "23505" ? 409 : 400,
    );
  }
  await logAction("folder_create", undefined, { folder_id: data.id, name });
  return c.json(data, 201);
});

folderRoutes.patch("/folders/:id", async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return fail(c, "Invalid folder id");
  const body = await jsonBody<{ name?: unknown; parent_id?: unknown }>(c);
  const update: Record<string, unknown> = {};

  if (body?.name !== undefined) {
    const name = cleanName(body.name);
    if (!name || name.length > 100) return fail(c, nameError);
    update.name = name;
  }
  if (body?.parent_id !== undefined) {
    const parent = body.parent_id;
    if (parent !== null && (!isUuid(parent) || parent === id)) return fail(c, "Invalid destination folder");
    if (typeof parent === "string") {
      if (descendants(id, await allFolders()).has(parent)) {
        return fail(c, "A folder cannot be moved inside itself");
      }
      if (!await folderExists(parent)) return fail(c, "Destination folder not found", 404);
    }
    update.parent_id = parent;
  }
  if (!Object.keys(update).length) return fail(c, "No changes supplied");
  update.updated_at = new Date().toISOString();

  const { data, error } = await db.from("folders").update(update).eq("id", id).select(FOLDER_COLUMNS)
    .maybeSingle();
  if (error) {
    return fail(
      c,
      error.code === "23505" ? duplicateError : "Unable to update folder",
      error.code === "23505" ? 409 : 400,
    );
  }
  if (!data) return fail(c, "Folder not found", 404);
  await logAction(update.name ? "folder_rename" : "folder_move", undefined, {
    folder_id: id,
    name: data.name,
  });
  return c.json(data);
});

folderRoutes.delete("/folders/:id", async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return fail(c, "Invalid folder id");
  const { data: folder } = await db.from("folders").select("name").eq("id", id).maybeSingle();
  if (!folder) return fail(c, "Folder not found", 404);
  // One transaction in Postgres: files and subfolders move up, the incoming-folder setting is reset, then the folder is deleted.
  const { error } = await db.rpc("delete_folder", { p_id: id });
  if (error) {
    return fail(
      c,
      error.code === "23505"
        ? "A folder with the same name already exists in the parent folder. Rename one of them first."
        : "Unable to delete folder",
      error.code === "23505" ? 409 : 500,
    );
  }
  await logAction("folder_delete", undefined, { name: folder.name });
  return c.json({ ok: true });
});

folderRoutes.post("/folders/:id/copy", async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return fail(c, "Invalid folder id");
  const body = await jsonBody<{ parent_id?: unknown }>(c);
  const parentId = body?.parent_id === undefined ? null : body.parent_id;
  if (parentId !== null && !isUuid(parentId)) return fail(c, "Invalid destination folder");
  const { data, error } = await db.rpc("copy_folder", { p_id: id, p_parent: parentId });
  if (error) {
    if (error.code === "P0002") return fail(c, "Folder or destination not found", 404);
    return fail(c, "Unable to copy folder", 500);
  }
  await logAction("folder_copy", undefined, { source_folder_id: id, copied_folder_id: data });
  return c.json({ ok: true, folder_id: data }, 201);
});
