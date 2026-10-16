/**
 * Registers the Telegram webhook with the right settings.
 *   deno task webhook            register / update
 *   deno task webhook --info     show the current webhook
 *
 * Reads BOT_TOKEN, APP_URL and TELEGRAM_WEBHOOK_SECRET from the environment (or a .env file passed with --env-file).
 */
const env = (key: string) => {
  const value = Deno.env.get(key)?.trim();
  if (!value) {
    console.error(`Missing environment variable: ${key}`);
    Deno.exit(1);
  }
  return value;
};

const token = env("BOT_TOKEN");
const call = async (method: string, body?: Record<string, unknown>) => {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return await response.json();
};

if (Deno.args.includes("--info")) {
  console.log(JSON.stringify((await call("getWebhookInfo")).result, null, 2));
  Deno.exit(0);
}

const appUrl = env("APP_URL").replace(/\/+$/, "");
const result = await call("setWebhook", {
  url: `${appUrl}/telegram/webhook`,
  secret_token: env("TELEGRAM_WEBHOOK_SECRET"),
  // callback_query is required for the Previous / Next, Favorite and Revoke buttons in the bot.
  allowed_updates: ["message", "callback_query"],
  drop_pending_updates: false,
});
console.log(result.ok ? `Webhook set to ${appUrl}/telegram/webhook` : `Failed: ${result.description}`);
console.log(JSON.stringify((await call("getWebhookInfo")).result, null, 2));
