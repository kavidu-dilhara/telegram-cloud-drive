import { Hono } from "hono";
import denoConfig from "../../deno.json" with { type: "json" };
import { allowedOrigins, config } from "../config.ts";
import { db, filesByIds, folderExists, logAction } from "../db.ts";
import { type AppEnv, fail, jsonBody } from "../http.ts";
import { isUuid } from "../lib.ts";
import { bot } from "../telegram.ts";

export const systemRoutes = new Hono<AppEnv>();

/** Where this instance runs (set by Deno Deploy). Instances are short-lived, so process uptime would be meaningless. */
function hosting() {
  try {
    return {
      region: Deno.env.get("DENO_REGION") ?? null,
      deployment: Deno.env.get("DENO_DEPLOYMENT_ID")?.slice(0, 8) ?? null,
    };
  } catch {
    return { region: null, deployment: null };
  }
}

export const DEFAULT_SETTINGS = {
  theme: "system",
  compact_mode: false,
  default_sort: "newest",
  default_view: "list",
  confirm_delete: true,
  confirm_move: true,
  incoming_folder_id: null as string | null,
};

async function loadSettings() {
  const { data, error } = await db.from("settings").select("key,value");
  if (error) throw error;
  const stored = Object.fromEntries((data ?? []).map((row) => [row.key, row.value]));
  return { ...DEFAULT_SETTINGS, ...stored };
}

systemRoutes.get("/settings", async (c) => {
  try {
    return c.json(await loadSettings());
  } catch {
    return fail(c, "Unable to load settings", 500);
  }
});

systemRoutes.patch("/settings", async (c) => {
  const body = await jsonBody<Record<string, unknown>>(c);
  if (!body) return fail(c, "Invalid settings payload");
  const updates = Object.entries(body).filter(([key]) => key in DEFAULT_SETTINGS);
  if (!updates.length) return fail(c, "No supported settings supplied");

  for (const [key, value] of updates) {
    if (key === "theme" && !["system", "light", "dark"].includes(String(value))) {
      return fail(c, "Invalid theme");
    }
    if (["compact_mode", "confirm_delete", "confirm_move"].includes(key) && typeof value !== "boolean") {
      return fail(c, `Invalid ${key}`);
    }
    if (key === "default_sort" && !["newest", "oldest", "name", "size"].includes(String(value))) {
      return fail(c, "Invalid sort order");
    }
    if (key === "default_view" && !["list", "grid"].includes(String(value))) return fail(c, "Invalid view");
    if (key === "incoming_folder_id" && value !== null && (!isUuid(value) || !await folderExists(value))) {
      return fail(c, "Invalid incoming folder");
    }
  }
  const stamp = new Date().toISOString();
  const { error } = await db.from("settings").upsert(
    updates.map(([key, value]) => ({ key, value, updated_at: stamp })),
  );
  if (error) return fail(c, "Unable to save settings", 500);
  await logAction("settings_update", undefined, { keys: updates.map(([key]) => key) });
  return c.json(await loadSettings());
});

systemRoutes.get("/dashboard", async (c) => {
  const { data, error } = await db.rpc("cloud_drive_dashboard").maybeSingle<
    { active_files: number; active_bytes: number; folder_count: number; trash_count: number }
  >();
  if (error || !data) return fail(c, "Unable to load dashboard", 500);
  return c.json({
    count: Number(data.active_files ?? 0),
    bytes: Number(data.active_bytes ?? 0),
    folderCount: Number(data.folder_count ?? 0),
    trashCount: Number(data.trash_count ?? 0),
    trashRetentionDays: config.trashRetentionDays,
  });
});

// ------------------------------------------------------------ live status

async function timed<T>(
  action: () => Promise<T>,
): Promise<{ ok: true; ms: number; value: T } | { ok: false; ms: number; error: string }> {
  const started = performance.now();
  try {
    const value = await action();
    return { ok: true, ms: Math.round(performance.now() - started), value };
  } catch (error) {
    return {
      ok: false,
      ms: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Every value here is measured on request; nothing is hard-coded. */
systemRoutes.get("/status", async (c) => {
  const [database, telegram, webhook, channel] = await Promise.all([
    timed(async () => {
      const { error } = await db.from("settings").select("key", { count: "exact", head: true });
      if (error) throw new Error(error.message);
    }),
    timed(() => bot.api.getMe()),
    timed(() => bot.api.getWebhookInfo()),
    timed(async () => {
      const me = await bot.api.getMe();
      const [chat, member] = await Promise.all([
        bot.api.getChat(config.channelId),
        bot.api.getChatMember(config.channelId, me.id),
      ]);
      const canPost = member.status === "creator" ||
        (member.status === "administrator" && member.can_post_messages !== false);
      return { title: "title" in chat ? chat.title : null, status: member.status, canPost };
    }),
  ]);

  const expectedWebhook = webhook.ok ? webhook.value : null;
  const callbacksAllowed = !expectedWebhook?.allowed_updates ||
    expectedWebhook.allowed_updates.includes("callback_query");

  return c.json({
    checked_at: new Date().toISOString(),
    backend: {
      ok: true,
      version: denoConfig.version,
      ...hosting(),
      allowed_origins: allowedOrigins.length,
    },
    database: database.ok
      ? { ok: true, latency_ms: database.ms }
      : { ok: false, latency_ms: database.ms, error: database.error },
    telegram: telegram.ok
      ? { ok: true, latency_ms: telegram.ms, bot_username: telegram.value.username ?? null }
      : { ok: false, latency_ms: telegram.ms, error: telegram.error },
    webhook: webhook.ok
      ? {
        ok: Boolean(webhook.value.url) && callbacksAllowed && !webhook.value.last_error_message,
        url_set: Boolean(webhook.value.url),
        pending_updates: webhook.value.pending_update_count,
        callbacks_allowed: callbacksAllowed,
        last_error: webhook.value.last_error_message ?? null,
      }
      : { ok: false, error: webhook.error },
    channel: channel.ok
      ? {
        ok: channel.value.canPost,
        title: channel.value.title,
        bot_role: channel.value.status,
        can_post: channel.value.canPost,
      }
      : { ok: false, error: channel.error },
    retention: { trash_days: config.trashRetentionDays, activity_days: config.activityRetentionDays },
  });
});

// ---------------------------------------------------------------- activity

systemRoutes.get("/activity", async (c) => {
  const { data, error } = await db.from("activity_logs").select("id,action,file_id,details,created_at").order(
    "created_at",
    { ascending: false },
  ).limit(100);
  if (error) return fail(c, "Unable to load activity", 500);
  const ids = [...new Set((data ?? []).map((row) => row.file_id).filter((id): id is string => Boolean(id)))];
  const files = await filesByIds<{ id: string; file_name: string }>(ids, "id,file_name");
  const names = new Map(files.map((file) => [file.id, file.file_name]));
  const items = (data ?? []).map((row) => ({
    ...row,
    file_name: (row.file_id && names.get(row.file_id)) ||
      (typeof row.details?.file_name === "string" ? row.details.file_name : null),
  }));
  return c.json({ items, retention_days: config.activityRetentionDays });
});

systemRoutes.delete("/activity", async (c) => {
  const { count, error } = await db.from("activity_logs").delete({ count: "exact" }).gte(
    "created_at",
    "1970-01-01",
  );
  if (error) return fail(c, "Unable to clear activity", 500);
  return c.json({ ok: true, count: count ?? 0, retention_days: config.activityRetentionDays });
});
