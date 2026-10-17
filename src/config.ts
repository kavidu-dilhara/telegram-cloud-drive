const required = (key: string) => {
  const value = Deno.env.get(key)?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
};

const optional = (key: string) => Deno.env.get(key)?.trim() || undefined;

const positiveInt = (key: string, fallback: number) => {
  const raw = Deno.env.get(key)?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${key} must be a positive whole number`);
  return value;
};

const origin = (value: string | undefined) => value?.replace(/\/+$/, "");

/** Header that carries the real client address, only when the hosting platform sets or overwrites it. */
const trustedIpHeader = (value: string | undefined): "cf-connecting-ip" | "x-forwarded-for" | undefined => {
  const header = value?.toLowerCase();
  if (header === undefined) return undefined;
  if (header !== "cf-connecting-ip" && header !== "x-forwarded-for") {
    throw new Error("TRUSTED_IP_HEADER must be empty, cf-connecting-ip or x-forwarded-for");
  }
  return header;
};

export const config = {
  botToken: required("BOT_TOKEN"),
  ownerId: Number(required("BOT_OWNER_ID")),
  webhookSecret: required("TELEGRAM_WEBHOOK_SECRET"),
  channelId: Number(required("STORAGE_CHANNEL_ID")),
  miniAppUrl: origin(required("MINI_APP_URL"))!,
  supabaseUrl: required("SUPABASE_URL"),
  supabaseKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  sessionSecret: required("SESSION_SECRET"),
  botUsername: optional("BOT_USERNAME")?.replace(/^@/, ""),
  devOrigin: origin(optional("DEV_ORIGIN")),
  trashRetentionDays: positiveInt("TRASH_RETENTION_DAYS", 30),
  activityRetentionDays: positiveInt("ACTIVITY_RETENTION_DAYS", 30),
  port: positiveInt("PORT", 8000),
  trustedIpHeader: trustedIpHeader(optional("TRUSTED_IP_HEADER")),
  trustedProxyHops: positiveInt("TRUSTED_PROXY_HOPS", 1),
};

if (!Number.isSafeInteger(config.ownerId) || !Number.isSafeInteger(config.channelId)) {
  throw new Error("BOT_OWNER_ID and STORAGE_CHANNEL_ID must be integer Telegram IDs");
}
if (config.sessionSecret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
if (config.webhookSecret.length < 32 || !/^[A-Za-z0-9_-]+$/.test(config.webhookSecret)) {
  throw new Error("TELEGRAM_WEBHOOK_SECRET must be 32+ characters using only A-Z, a-z, 0-9, _ and -");
}
if (config.webhookSecret === config.sessionSecret) {
  throw new Error("TELEGRAM_WEBHOOK_SECRET and SESSION_SECRET must be different");
}
if (!/^https:\/\//i.test(config.miniAppUrl)) throw new Error("MINI_APP_URL must use HTTPS");

/** Browser origins allowed to call the API. */
export const allowedOrigins = [config.miniAppUrl, ...(config.devOrigin ? [config.devOrigin] : [])];
