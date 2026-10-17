import type { Context } from "hono";
import { getConnInfo } from "hono/deno";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { resolveClientIp } from "./lib.ts";

export const LOGIN_WINDOW_SECONDS = 15 * 60;

/** How long throttling stays refused after a counter write failed (the check fails closed, not open). */
const DEGRADED_MS = 60_000;
let degradedUntil = 0;

export interface LimitRule {
  key: string;
  max: number;
}

/** Thrown when the failure counters cannot be trusted, so callers must refuse the attempt. */
export class ThrottleUnavailableError extends Error {
  constructor(message = "Login throttling is unavailable") {
    super(message);
    this.name = "ThrottleUnavailableError";
  }
}

/** Test helper: forget that a counter write failed. */
export const resetThrottleState = () => {
  degradedUntil = 0;
};

/**
 * True when any rule has reached its failure limit inside its current window.
 * Throws ThrottleUnavailableError when the counters cannot be read or a recent write failed.
 */
export async function isLimited(rules: LimitRule[]): Promise<boolean> {
  if (Date.now() < degradedUntil) throw new ThrottleUnavailableError();
  let result;
  try {
    result = await db.from("login_attempts").select("key,failures").in(
      "key",
      rules.map((rule) => rule.key),
    ).gt("window_ends_at", new Date().toISOString());
  } catch (error) {
    result = { data: null, error: error as { message?: string } };
  }
  if (result.error || !Array.isArray(result.data)) {
    console.error("Login rate-limit lookup failed", result.error?.message ?? "no data returned");
    throw new ThrottleUnavailableError();
  }
  return result.data.some((row) => rules.some((rule) => rule.key === row.key && row.failures >= rule.max));
}

/**
 * Counts one failure for every key (stored in the database, so it works across isolates).
 * A failed write is logged and makes the next checks refuse for a minute instead of silently
 * leaving the account unthrottled.
 */
export async function recordFailure(keys: string[]) {
  const results = await Promise.allSettled(
    keys.map((key) =>
      db.rpc("register_login_failure", { p_key: key, p_window_seconds: LOGIN_WINDOW_SECONDS })
    ),
  );
  const failed = results.find((result) => result.status === "rejected" || result.value.error);
  if (failed) {
    const reason = failed.status === "rejected" ? failed.reason : failed.value.error?.message;
    console.error("Unable to record a failed sign-in", reason);
    degradedUntil = Date.now() + DEGRADED_MS;
  }
}

export async function clearFailures(keys: string[]) {
  try {
    const { error } = await db.from("login_attempts").delete().in("key", keys);
    if (error) console.error("Unable to clear sign-in counters", error.message);
  } catch (error) {
    console.error("Unable to clear sign-in counters", error);
  }
}

/** Address of the caller. Forwarding headers are only honoured when TRUSTED_IP_HEADER is configured. */
export function clientIp(c: Context) {
  let remote: string | undefined;
  try {
    remote = getConnInfo(c).remote.address;
  } catch {
    remote = undefined; // not served by Deno.serve (for example in tests)
  }
  return resolveClientIp(c.req.raw.headers, remote, {
    header: config.trustedIpHeader,
    hops: config.trustedProxyHops,
  });
}
