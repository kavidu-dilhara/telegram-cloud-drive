import { db } from "./db.ts";

export const LOGIN_WINDOW_SECONDS = 15 * 60;

export interface LimitRule {
  key: string;
  max: number;
}

/** True when any rule has reached its failure limit inside its current window. */
export async function isLimited(rules: LimitRule[]): Promise<boolean> {
  const { data } = await db.from("login_attempts").select("key,failures").in(
    "key",
    rules.map((rule) => rule.key),
  ).gt("window_ends_at", new Date().toISOString());
  return (data ?? []).some((row) => rules.some((rule) => rule.key === row.key && row.failures >= rule.max));
}

/** Counts one failure for every key (stored in the database, so it works across isolates). */
export async function recordFailure(keys: string[]) {
  await Promise.all(
    keys.map((key) =>
      db.rpc("register_login_failure", { p_key: key, p_window_seconds: LOGIN_WINDOW_SECONDS })
    ),
  );
}

export async function clearFailures(keys: string[]) {
  await db.from("login_attempts").delete().in("key", keys);
}

/** The first address of X-Forwarded-For. Advisory only: per-account limits are what actually protect the login. */
export function clientIp(headers: Headers) {
  const forwarded = headers.get("CF-Connecting-IP") ?? headers.get("X-Forwarded-For") ?? "unknown";
  return forwarded.split(",")[0].trim().slice(0, 64) || "unknown";
}
