import { config } from "./config.ts";
import { db } from "./db.ts";
import { type ChannelMessage, deleteChannelMessages } from "./telegram.ts";

const HOUR = 3600_000;
let lastRun = 0;
let running = false;

export interface MaintenanceResult {
  purgedFiles: number;
  deletedMessages: number;
  deletedActivity: number;
}

/** Permanently deletes trashed files (and their channel messages) older than `olderThanDays`, or all when null. */
export async function purgeTrash(olderThanDays: number | null): Promise<{ purged: number; deleted: number }> {
  const cutoff = olderThanDays === null
    ? null
    : new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
  const { data, error } = await db.rpc("purge_trashed_files", { p_older_than: cutoff });
  if (error) throw error;
  const rows = (data ?? []) as Array<ChannelMessage & { orphaned: boolean }>;
  const deleted = await deleteChannelMessages(rows.filter((row) => row.orphaned));
  return { purged: rows.length, deleted };
}

export async function runMaintenance(): Promise<MaintenanceResult> {
  const result: MaintenanceResult = { purgedFiles: 0, deletedMessages: 0, deletedActivity: 0 };
  const purge = await purgeTrash(config.trashRetentionDays);
  result.purgedFiles = purge.purged;
  result.deletedMessages = purge.deleted;

  const activityCutoff = new Date(Date.now() - config.activityRetentionDays * 86_400_000).toISOString();
  const { count } = await db.from("activity_logs").delete({ count: "exact" }).lt(
    "created_at",
    activityCutoff,
  );
  result.deletedActivity = count ?? 0;

  await db.from("login_attempts").delete().lt("window_ends_at", new Date().toISOString());
  return result;
}

/** Runs the cleanup at most once an hour per isolate; safe to call on every request. */
export function maybeRunMaintenance() {
  if (running || Date.now() - lastRun < HOUR) return;
  running = true;
  lastRun = Date.now();
  runMaintenance().catch((error) => console.error("Maintenance failed", error)).finally(
    () => (running = false),
  );
}

/** Registers a daily Deno Deploy cron job when the runtime supports it. */
export function scheduleMaintenance() {
  try {
    const cron =
      (Deno as unknown as { cron?: (name: string, schedule: string, handler: () => Promise<void>) => void })
        .cron;
    cron?.("cloud-drive-maintenance", "17 3 * * *", async () => {
      await runMaintenance();
    });
  } catch (error) {
    console.warn("Deno.cron is unavailable; maintenance runs lazily instead", String(error));
  }
}
