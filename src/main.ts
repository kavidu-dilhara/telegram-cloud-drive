import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { webhookCallback } from "grammy";
import { allowedOrigins, config } from "./config.ts";
import { apiBodyLimit, type AppEnv, fail } from "./http.ts";
import { safeEqualText } from "./lib.ts";
import { scheduleMaintenance } from "./maintenance.ts";
import { originGuard, privateAuth, publicAuth, requireAuth } from "./routes/auth.ts";
import { fileRoutes } from "./routes/files.ts";
import { folderRoutes } from "./routes/folders.ts";
import { shareRoutes } from "./routes/shares.ts";
import { systemRoutes } from "./routes/system.ts";
import { bot } from "./bot.ts";

const app = new Hono<AppEnv>();

app.use("*", logger());
app.get("/health", (c) => c.json({ ok: true, service: "telegram-cloud-drive" }));
app.get("/", (c) => c.redirect(config.miniAppUrl));

// Telegram -> backend. The secret header is compared in constant time.
const handleWebhook = webhookCallback(bot, "std/http");
app.post("/telegram/webhook", (c) => {
  const secret = c.req.header("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!safeEqualText(secret, config.webhookSecret)) return c.text("Unauthorized", 401);
  return handleWebhook(new Request(c.req.raw));
});

// Browser -> backend.
app.use(
  "/api/*",
  cors({
    origin: (origin) => (allowedOrigins.includes(origin) ? origin : null),
    credentials: true,
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  }),
);
app.use("/api/*", apiBodyLimit);
app.use("/api/*", originGuard);
app.route("/api/auth", publicAuth);
app.use("/api/*", requireAuth);
app.route("/api/auth", privateAuth);
app.route("/api", fileRoutes);
app.route("/api", folderRoutes);
app.route("/api", shareRoutes);
app.route("/api", systemRoutes);

app.notFound((c) => fail(c, "Not found", 404));
app.onError((error, c) => {
  console.error("Unhandled error", c.req.method, c.req.path, error);
  return fail(c, "Something went wrong on the server", 500);
});

scheduleMaintenance();
Deno.serve({ port: config.port }, app.fetch);
