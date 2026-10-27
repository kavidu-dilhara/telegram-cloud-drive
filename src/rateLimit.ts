import { logError } from "./redact.ts";
import type { Context } from "hono";
import { getConnInfo } from "hono/deno";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { resolveClientIp } from "./lib.ts";

export const LOGIN_WINDOW_SECONDS = 15 * 60;

export interface LimitRule {
  key: string;
  max: number;
}

/** Thrown when the attempt counters cannot be used, so callers must refuse the attempt (fail closed). */
export class ThrottleUnavailableError extends Error {
  constructor(message = "Login throttling is unavailable") {
    super(message);
    this.name = "ThrottleUnavailableError";
  }
}

/**
 * Counts one attempt against every rule in a single atomic database step and says whether it may go ahead.
 * Because the attempt is counted BEFORE the slow password check, parallel requests cannot all pass together.
 * Returns false (nothing counted) when any rule is already at its limit. Throws ThrottleUnavailableError
 * when the counters cannot be reached.
 */
export async function reserveAttempt(rules: LimitRule[]): Promise<boolean> {
  let result;
  try {
    result = await db.rpc("reserve_login_attempt", {
      p_keys: rules.map((rule) => rule.key),
      p_maxes: rules.map((rule) => rule.max),
      p_window_seconds: LOGIN_WINDOW_SECONDS,
    });
  } catch (error) {
    result = { data: null, error: error as { message?: string } };
  }
  if (result.error || typeof result.data !== "boolean") {
    console.error("Login rate-limit check failed", result.error?.message ?? "unexpected answer");
    throw new ThrottleUnavailableError();
  }
  return result.data;
}

/** After a successful sign-in: forget the failures of these keys. */
export async function clearFailures(keys: string[]) {
  try {
    const { error } = await db.from("login_attempts").delete().in("key", keys);
    if (error) console.error("Unable to clear sign-in counters", error.message);
  } catch (error) {
    logError("Unable to clear sign-in counters", error);
  }
}

/** After a successful sign-in: give back the attempt that was reserved on a shared counter. */
export async function refundAttempt(keys: string[]) {
  try {
    const { error } = await db.rpc("refund_login_attempt", { p_keys: keys });
    if (error) console.error("Unable to refund a sign-in attempt", error.message);
  } catch (error) {
    logError("Unable to refund a sign-in attempt", error);
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
