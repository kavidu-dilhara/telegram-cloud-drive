import type { Context } from "hono";
import type { SessionClaims } from "./security.ts";

export type AppEnv = { Variables: { session: SessionClaims } };
export type Ctx = Context<AppEnv>;

export async function jsonBody<T>(c: Context): Promise<T | null> {
  try {
    const value = await c.req.json();
    return value && typeof value === "object" ? value as T : null;
  } catch {
    return null;
  }
}

export const fail = (
  c: Context,
  message: string,
  status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 500 | 502 = 400,
) => c.json({ error: message }, status);
