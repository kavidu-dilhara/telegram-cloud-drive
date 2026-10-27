import { config } from "./config.ts";

/** Secrets that must never reach a log line or the database. */
const secrets =
  () => [config.botToken, config.sessionSecret, config.webhookSecret, config.shareSecret, config.supabaseKey];

/**
 * Removes the bot token (in any URL form) and the other secrets from text. Network errors carry the full request
 * URL, and Telegram's URLs contain the bot token ("https://api.telegram.org/bot<token>/getFile").
 */
export function redactSecrets(text: string): string {
  let result = text.replace(/bot\d{3,}:[A-Za-z0-9_-]{10,}/g, "bot<redacted>");
  for (const secret of secrets()) {
    if (secret && secret.length >= 8) result = result.split(secret).join("<redacted>");
  }
  return result;
}

/** The full text of an error, including its causes, with secrets removed. */
export function describeError(error: unknown): string {
  let text: string;
  try {
    text = typeof error === "string" ? error : Deno.inspect(error, { depth: 8, colors: false });
  } catch {
    text = String(error);
  }
  return redactSecrets(text);
}

const clean = (details: unknown[]) =>
  details.map((detail) =>
    typeof detail === "string" || typeof detail === "number" || detail === undefined || detail === null
      ? (typeof detail === "string" ? redactSecrets(detail) : detail)
      : describeError(detail)
  );

/** console.error that is safe to use with caught errors. */
export const logError = (label: string, ...details: unknown[]) => console.error(label, ...clean(details));

/** console.warn that is safe to use with caught errors. */
export const logWarn = (label: string, ...details: unknown[]) => console.warn(label, ...clean(details));
