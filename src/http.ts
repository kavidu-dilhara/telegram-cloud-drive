import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { SessionClaims } from "./security.ts";

export type AppEnv = { Variables: { session: SessionClaims } };
export type Ctx = Context<AppEnv>;

/** Largest accepted request body: sign-in routes carry a few hundred bytes, everything else a few KB. */
export const AUTH_BODY_LIMIT = 16 * 1024;
export const API_BODY_LIMIT = 64 * 1024;

/** Rejects oversized bodies (413) before any route reads or parses them. */
export const apiBodyLimit: MiddlewareHandler = (c, next) =>
  bodyLimit({
    maxSize: c.req.path.startsWith("/api/auth/") ? AUTH_BODY_LIMIT : API_BODY_LIMIT,
    onError: (ctx) => fail(ctx, "Request body is too large", 413),
  })(c, next);

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
  status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 500 | 502 | 503 = 400,
) => c.json({ error: message }, status);
