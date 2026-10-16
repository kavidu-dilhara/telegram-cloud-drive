// Sets the environment the modules need so unit tests can import them without real credentials.
Deno.env.set("BOT_TOKEN", "123456:unit-test-token");
Deno.env.set("BOT_OWNER_ID", "42");
Deno.env.set("TELEGRAM_WEBHOOK_SECRET", "test-webhook-secret-0123456789-abcdefghij");
Deno.env.set("STORAGE_CHANNEL_ID", "-100123456789");
Deno.env.set("MINI_APP_URL", "https://drive.example.test");
Deno.env.set("SUPABASE_URL", "https://project.supabase.co");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
Deno.env.set("SESSION_SECRET", "a-secure-test-session-secret-with-32-bytes-or-more");
