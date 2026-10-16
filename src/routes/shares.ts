import { Hono } from "hono";
import { db, filesByIds, logAction } from "../db.ts";
import { type AppEnv, fail } from "../http.ts";
import { isUuid, sha256Hex } from "../lib.ts";
import { decryptToken, encryptToken, newShareToken } from "../security.ts";
import { shareUrl } from "../telegram.ts";

export const shareRoutes = new Hono<AppEnv>();

shareRoutes.get("/shares", async (c) => {
  const { data, error } = await db.from("shares").select("id,file_id,share_token_enc,created_at").order(
    "created_at",
    { ascending: false },
  ).limit(500);
  if (error) return fail(c, "Unable to load share links", 500);
  const files = await filesByIds<{ id: string; file_name: string; file_size: number }>(
    (data ?? []).map((share) => share.file_id),
    "id,file_name,file_size",
    true,
  );
  const byId = new Map(files.map((file) => [file.id, file]));
  const shares = await Promise.all(
    (data ?? []).filter((share) => byId.has(share.file_id)).map(async (share) => {
      const token = await decryptToken(share.share_token_enc);
      return {
        id: share.id,
        file_id: share.file_id,
        created_at: share.created_at,
        file: byId.get(share.file_id),
        url: token ? await shareUrl(token) : null,
      };
    }),
  );
  return c.json(shares);
});

shareRoutes.post("/files/:id/share", async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return fail(c, "Invalid file id");
  const { data: file } = await db.from("files").select("id,file_name").eq("id", id).eq("status", "active")
    .maybeSingle();
  if (!file) return fail(c, "File not found", 404);

  // One link per file: reuse the existing one instead of creating a pile of links.
  const { data: existing } = await db.from("shares").select("id,share_token_enc,created_at").eq("file_id", id)
    .limit(1).maybeSingle();
  const existingToken = await decryptToken(existing?.share_token_enc);
  if (existing && existingToken) {
    return c.json({
      id: existing.id,
      file_id: id,
      created_at: existing.created_at,
      url: await shareUrl(existingToken),
    });
  }
  if (existing) await db.from("shares").delete().eq("id", existing.id); // unreadable legacy link: replace it

  const token = newShareToken();
  const { data, error } = await db.from("shares").insert({
    file_id: id,
    token_hash: await sha256Hex(token),
    share_token_enc: await encryptToken(token),
  }).select("id,file_id,created_at").single();
  if (error) return fail(c, "Unable to create share link", 500);
  await logAction("share_create", id, { file_name: file.file_name });
  return c.json({ ...data, url: await shareUrl(token) }, 201);
});

shareRoutes.delete("/shares/:id", async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return fail(c, "Invalid share id");
  const { data, error } = await db.from("shares").delete().eq("id", id).select("file_id").maybeSingle();
  if (error) return fail(c, "Unable to revoke share link", 500);
  if (!data) return fail(c, "Share link not found", 404);
  await logAction("share_revoke", data.file_id);
  return c.json({ ok: true });
});
