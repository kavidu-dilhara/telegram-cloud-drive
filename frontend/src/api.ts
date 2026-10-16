export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

let token: string | null = null;
let onUnauthorized: (() => void) | null = null;

/** Bearer token kept in memory only. The HttpOnly cookie is the primary session; the token is a fallback for webviews that block cookies. */
export const setToken = (value: string | null) => {
  token = value;
};
export const setUnauthorizedHandler = (handler: (() => void) | null) => {
  onUnauthorized = handler;
};

/** Plain-language text for errors that did not come from our own API (hosting error pages, proxies). */
function describeHttpFailure(status: number): string {
  if (status === 404) return "Server not found (HTTP 404). Check that frontend/vercel.json points to your backend address.";
  if (status >= 500) return `The server is not responding correctly (HTTP ${status}). Open your backend /health page and check its logs.`;
  return `Request failed (HTTP ${status}).`;
}

const PUBLIC_PATHS = [
  "/api/auth/telegram",
  "/api/auth/method",
  "/api/auth/password/login",
  "/api/auth/logout",
];

export async function api<T>(
  path: string,
  init: RequestInit & { json?: unknown; quiet401?: boolean } = {},
): Promise<T> {
  const { json, quiet401, ...rest } = init;
  const headers: Record<string, string> = { ...(rest.headers as Record<string, string> | undefined) };
  if (json !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(path, {
      ...rest,
      headers,
      credentials: "include",
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch {
    throw new ApiError("Cannot reach the server. Check your connection and try again.", 0);
  }

  if (!response.ok) {
    let message = describeHttpFailure(response.status);
    try {
      message = ((await response.json()) as { error?: string }).error ?? message;
    } catch {
      /* not JSON: the platform or proxy answered instead of the backend, keep the explanation */
    }
    if (response.status === 401 && !quiet401 && !PUBLIC_PATHS.includes(path)) onUnauthorized?.();
    throw new ApiError(message, response.status);
  }
  return (await response.json()) as T;
}

export const messageOf = (
  error: unknown,
  fallback: string,
) => (error instanceof Error && error.message ? error.message : fallback);

/** Loads a protected image as a blob URL, sending the same credentials as every other request. */
export async function fetchBlobUrl(path: string): Promise<string> {
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await fetch(path, { headers, credentials: "include" });
  if (!response.ok) throw new ApiError("Preview unavailable", response.status);
  return URL.createObjectURL(await response.blob());
}
