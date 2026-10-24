export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

let token: string | null = null;
/** Called when a signed-in request gets 401. Resolves true if the session was silently renewed. */
let onUnauthorized: (() => Promise<boolean>) | null = null;
let recovering: Promise<boolean> | null = null;

/** Bearer token kept in memory only. The HttpOnly cookie is the primary session; the token is a fallback for webviews that block cookies. */
export const setToken = (value: string | null) => {
  token = value;
};
export const setUnauthorizedHandler = (handler: (() => Promise<boolean>) | null) => {
  onUnauthorized = handler;
};

/** One recovery at a time: requests that fail together wait for the same attempt. */
function recoverSession(): Promise<boolean> {
  if (!onUnauthorized) return Promise.resolve(false);
  recovering ??= onUnauthorized().catch(() => false).finally(() => {
    recovering = null;
  });
  return recovering;
}

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

/** One request with the current credentials. A 401 on a signed-in route renews the session and repeats it once. */
async function requestWithSession(path: string, init: RequestInit & { quiet401?: boolean }, body?: BodyInit | null) {
  const { quiet401, ...rest } = init;
  const send = async (): Promise<Response> => {
    const headers: Record<string, string> = { ...(rest.headers as Record<string, string> | undefined) };
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      return await fetch(path, { ...rest, headers, credentials: "include", body });
    } catch {
      throw new ApiError("Cannot reach the server. Check your connection and try again.", 0);
    }
  };
  const response = await send();
  if (response.status === 401 && !quiet401 && !PUBLIC_PATHS.includes(path) && await recoverSession()) {
    return send();
  }
  return response;
}

export async function api<T>(
  path: string,
  init: RequestInit & { json?: unknown; quiet401?: boolean } = {},
): Promise<T> {
  const { json, ...rest } = init;
  const headers: Record<string, string> = { ...(rest.headers as Record<string, string> | undefined) };
  if (json !== undefined) headers["Content-Type"] = "application/json";
  const response = await requestWithSession(
    path,
    { ...rest, headers },
    json !== undefined ? JSON.stringify(json) : rest.body,
  );

  if (!response.ok) {
    let message = describeHttpFailure(response.status);
    try {
      message = ((await response.json()) as { error?: string }).error ?? message;
    } catch {
      /* not JSON: the platform or proxy answered instead of the backend, keep the explanation */
    }
    throw new ApiError(message, response.status);
  }
  return (await response.json()) as T;
}

export const messageOf = (
  error: unknown,
  fallback: string,
) => (error instanceof Error && error.message ? error.message : fallback);

/** Loads a protected image as a blob URL, with the same credentials and session renewal as every other request. */
export async function fetchBlobUrl(path: string): Promise<string> {
  const response = await requestWithSession(path, {});
  if (!response.ok) throw new ApiError("Preview unavailable", response.status);
  return URL.createObjectURL(await response.blob());
}
