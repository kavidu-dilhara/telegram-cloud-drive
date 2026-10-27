import { logError } from "./redact.ts";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { drainPendingDeletions, kickPendingDeletions } from "./telegram.ts";

const HOUR = 3600_000;
let lastRun = 0;
let running = false;

export interface MaintenanceResult {
  purgedFiles: number;
  /** Queued channel messages deleted during this run. */
  deletedMessages: number;
  deletedActivity: number;
}

/**
 * Permanently deletes trashed files (and deleted folders) older than `olderThanDays`, or all when null. The channel
 * messages nothing points at any more are queued by the database in the same step and deleted in the background.
 */
export async function purgeTrash(olderThanDays: number | null): Promise<{ purged: number }> {
  const cutoff = olderThanDays === null
    ? null
    : new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
  const { data, error } = await db.rpc("purge_trashed_files", { p_older_than: cutoff });
  if (error) throw error;
  kickPendingDeletions();
  return { purged: (data ?? []).length };
}

export async function runMaintenance(): Promise<MaintenanceResult> {
  const result: MaintenanceResult = { purgedFiles: 0, deletedMessages: 0, deletedActivity: 0 };
  const purge = await purgeTrash(config.trashRetentionDays);
  result.purgedFiles = purge.purged;

  const activityCutoff = new Date(Date.now() - config.activityRetentionDays * 86_400_000).toISOString();
  const { count, error: activityError } = await db.from("activity_logs").delete({ count: "exact" }).lt(
    "created_at",
    activityCutoff,
  );
  if (activityError) console.error("Maintenance: unable to clean the activity log", activityError.message);
  result.deletedActivity = count ?? 0;

  const { error: attemptsError } = await db.from("login_attempts").delete().lt(
    "window_ends_at",
    new Date().toISOString(),
  );
  if (attemptsError) {
    console.error("Maintenance: unable to clean old sign-in counters", attemptsError.message);
  }

  const { error: revokedError } = await db.from("revoked_sessions").delete().lt(
    "expires_at",
    new Date().toISOString(),
  );
  if (revokedError) {
    console.error("Maintenance: unable to clean old signed-out sessions", revokedError.message);
  }

  // Finish anything still queued (failed earlier, or left over from a stopped server); a short budget keeps this job brief.
  result.deletedMessages = (await drainPendingDeletions(60_000)).deleted;
  return result;
}

/** Runs the cleanup at most once an hour per isolate; safe to call on every request. */
export function maybeRunMaintenance() {
  if (running || Date.now() - lastRun < HOUR) return;
  running = true;
  lastRun = Date.now();
  runMaintenance().catch((error) => logError("Maintenance failed", error)).finally(
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
