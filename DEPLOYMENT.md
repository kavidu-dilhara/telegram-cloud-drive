# Deployment Guide

Deploy your own Cloud Drive by **forking this repository**. You never upload code by hand: you fork, fill in
the variables listed in `.env.example`, and let Deno Deploy and Vercel build from your fork. Allow about 30
minutes the first time.

Each step ends with a **Checkpoint** so you know it worked before moving on.

## Before you start

You need free accounts on these services:

| Service     | Used for                                              |
| ----------- | ----------------------------------------------------- |
| Telegram    | The bot, the private storage channel and the Mini App |
| GitHub      | Your fork of this repository                          |
| Supabase    | The database (folders, file names, favourites)        |
| Deno Deploy | Running the backend                                   |
| Vercel      | Hosting the Mini App screens                          |

Keep a text note open. You will collect about eight values (token, ids, keys, URLs) and paste them several
times.

## Step 1. Fork the repository

1. Open this repository on GitHub and click **Fork** (top right), then **Create fork**.
2. You now have your own copy at `https://github.com/kavidu-dilhara/telegram-cloud-drive`. Every later step
   uses this fork.

**Checkpoint:** your fork shows `src`, `frontend`, `supabase` and `README.md`. Never add a file named `.env`
to the fork; your secrets go into the hosting dashboards instead (step 7).

## Step 2. Create the Telegram bot

1. In Telegram open **@BotFather** and send `/newbot`.
2. Choose a display name, then a username ending in `bot`.
3. BotFather replies with a token like `123456789:ABC...`. Save it as **BOT_TOKEN**.

**Checkpoint:** you have a token and can open your bot by its username.

## Step 3. Find your Telegram user id

Open **@userinfobot** and send any message. It replies with a number. Save it as **BOT_OWNER_ID**. Only this
account will be able to use the bot and the app.

## Step 4. Create the private storage channel

1. In Telegram create a **new channel** and make it **Private**.
2. Open the channel settings, choose **Administrators**, add your bot, and turn on **Post Messages**.
3. Get the channel id. Either forward a post from the channel to **@RawDataBot** and read
   `forward_from_chat.id`, or post a message in the channel and open
   `https://api.telegram.org/botYOUR_TOKEN/getUpdates` in a browser and read `chat.id`.
4. The id looks like `-1001234567890`. Save it as **STORAGE_CHANNEL_ID**, including the minus sign.

**Checkpoint:** the bot is listed as an administrator, and the id starts with `-100`.

## Step 5. Create the database

1. Create a project at supabase.com and wait until it finishes setting up.
2. In your fork on GitHub open `supabase/schema.sql`, click **Copy raw file**, and keep it ready.
3. In Supabase open **SQL Editor**, choose **New query**, paste the file, and click **Run**. It should end
   with "Success".
4. Open **Project Settings → API**. Save the **Project URL** as **SUPABASE_URL**.
5. On the same page copy the **service_role** key (shown as the _secret_ key in newer dashboards) and save it
   as **SUPABASE_SERVICE_ROLE_KEY**. Never put this key in the frontend or share it.

The script is safe to run more than once: it uses "if not exists" everywhere and runs as a single transaction,
so a repeat run never gives "already exists" errors and never leaves half-created tables.

**Checkpoint:** _Table Editor_ lists `files`, `folders`, `shares`, `favorites`, `settings`, `users`,
`activity_logs` and `login_attempts`.

## Step 6. Generate two secrets

You need two different random strings.

- macOS or Linux: run `openssl rand -hex 32` twice.
- Windows PowerShell, run twice: `-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })`

Save the first as **TELEGRAM_WEBHOOK_SECRET** and the second as **SESSION_SECRET**. Each must be at least 32
characters and they must not match.

## Step 7. Deploy the backend (Deno Deploy)

1. Sign in at deno.com/deploy with GitHub and create a new project or app from **your fork**.
2. Set the **entry point** to `src/main.ts`. No build step is needed.
3. Open `.env.example` in your fork. It lists every variable the backend understands, with a short comment for
   each. Add them in the Deno Deploy project settings under **Environment variables**, using the values you
   collected:

   | Variable                    | Value                                                       |
   | --------------------------- | ----------------------------------------------------------- |
   | `BOT_TOKEN`                 | from step 2                                                 |
   | `BOT_OWNER_ID`              | from step 3                                                 |
   | `STORAGE_CHANNEL_ID`        | from step 4                                                 |
   | `SUPABASE_URL`              | from step 5                                                 |
   | `SUPABASE_SERVICE_ROLE_KEY` | from step 5                                                 |
   | `TELEGRAM_WEBHOOK_SECRET`   | from step 6                                                 |
   | `SESSION_SECRET`            | from step 6                                                 |
   | `MINI_APP_URL`              | `https://placeholder.example` for now; you fix it in step 9 |

   The remaining lines in `.env.example` (`APP_URL`, `BOT_USERNAME`, `DEV_ORIGIN`, `TRASH_RETENTION_DAYS`,
   `ACTIVITY_RETENTION_DAYS`, `PORT`, `TRUSTED_IP_HEADER`, `TRUSTED_PROXY_HOPS`) are optional. `APP_URL` is
   only used by the webhook command in step 10. Leave `TRUSTED_IP_HEADER` empty unless you know your host
   overwrites that header so visitors cannot forge it; the login is protected per account either way.

4. Deploy and copy the backend address, for example `https://my-drive.deno.dev`. Save it as **APP_URL**.

**Checkpoint:** opening `APP_URL/health` in a browser shows `{"ok":true,"service":"telegram-cloud-drive"}`. If
it shows an error, open the deployment logs: a message starting with "Missing required environment variable"
tells you which value to add.

## Step 8. Deploy the frontend (Vercel)

1. In your fork on GitHub open `frontend/vercel.json`, click the pencil icon, and replace
   `YOUR-BACKEND.deno.dev` with your backend host from step 7 (host only, no `https://`). Click **Commit
   changes**.
2. In Vercel choose **Add New → Project** and import your fork.
3. Set **Root Directory** to `frontend`. Vercel detects Vite; the build command is `npm run build` and the
   output directory is `dist`.
4. Deploy and copy the address, for example `https://my-drive.vercel.app`. Save it as **MINI_APP_URL**. Use
   the exact origin, with no trailing slash.

**Checkpoint:** opening the Vercel address in a browser shows the Cloud Drive sign-in screen.

## Step 9. Tell the backend where the frontend lives

In Deno Deploy change `MINI_APP_URL` from the placeholder to the Vercel address, then redeploy. The backend
only accepts requests from that exact origin.

**Checkpoint:** `APP_URL/health` still works after the redeploy.

## Step 10. Register the webhook

This tells Telegram where to send messages. It must include button presses, or `/files` paging and the
favourite buttons will not work. You do this once from your own computer; it does not run automatically.

**Option A, with Deno:** [install Deno](https://deno.com), clone your fork, copy `.env.example` to `.env`
(this file stays on your computer and is never committed), fill in `BOT_TOKEN`, `APP_URL` and
`TELEGRAM_WEBHOOK_SECRET`, then run:

```bash
deno task webhook
deno task webhook --info
```

**Option B, with curl** (replace the three capitalised values):

```bash
curl -X POST "https://api.telegram.org/botBOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"APP_URL/telegram/webhook","secret_token":"TELEGRAM_WEBHOOK_SECRET","allowed_updates":["message","callback_query"]}'
```

**Checkpoint:** the result shows `"ok": true`, and the `--info` output lists `message` and `callback_query`
under allowed updates with no `last_error_message`.

## Step 11. Add the Mini App button to the bot

1. In **@BotFather** send `/mybots` and choose your bot.
2. Open **Bot Settings → Menu Button → Configure menu button**.
3. Paste the Vercel address from step 8 and give the button a name such as Cloud Drive.

**Checkpoint:** open your bot and a **Cloud Drive** button appears next to the message box.

## Step 12. Test everything

1. In your bot send `/start`. You get a welcome message with an **Open Cloud Drive** button.
2. Send any file or photo. The bot replies "Saved", and the same file appears as a new message in the storage
   channel.
3. Tap **Open Cloud Drive**. Your file is listed.
4. Open **Settings → Live status**. Every row should say **OK**: database, Telegram bot, webhook and storage
   channel.
5. Try the main actions: create a folder, move the file into it, share it, move it to Trash and tap **Undo**.

**Checkpoint:** all live status rows are OK and the file round-trips.

## Step 13. Optional: sign in from a normal browser

In the app open **Settings → Account and security**, choose a username and a password of at least 12
characters, and save. You can now sign in at your Vercel address without Telegram. After 10 wrong attempts
sign-in pauses for 15 minutes; opening the app from Telegram always works.

## Getting updates later

1. On your fork's GitHub page click **Sync fork → Update branch**.
2. Deno Deploy and Vercel redeploy automatically.

If GitHub reports a conflict, it is almost always `frontend/vercel.json`: keep your own backend host and
accept the rest. If you ever change the backend address or `TELEGRAM_WEBHOOK_SECRET`, run step 10 again. If
you change `SESSION_SECRET`, everyone is signed out and existing share links can no longer be displayed in the
app (they still work for recipients).

Optional: GitHub disables workflows in forks by default. Open the **Actions** tab of your fork and enable them
if you want the automatic checks.

## If something goes wrong

| What you see                                                                                    | What to do                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/health` shows an error or the deployment fails                                                | Read the deployment log for "Missing required environment variable" and add the named value from `.env.example`.                                                                                                                                     |
| SQL error "already exists"                                                                      | Use the current `supabase/schema.sql`; it can be run again safely.                                                                                                                                                                                   |
| The bot does not react to files                                                                 | Run `deno task webhook --info`. Check that the URL is yours and that `last_error_message` is empty, then repeat step 10.                                                                                                                             |
| Buttons under `/files` do nothing                                                               | Repeat step 10; `callback_query` must be in allowed updates.                                                                                                                                                                                         |
| "Forbidden origin" in the app                                                                   | `MINI_APP_URL` in Deno Deploy must match the Vercel address exactly (no trailing slash). Redeploy.                                                                                                                                                   |
| Live status says the storage channel has a problem                                              | Make sure the bot is an admin of the channel with **Post Messages**, and that `STORAGE_CHANNEL_ID` starts with `-100`.                                                                                                                               |
| Live status says the database has a problem                                                     | Re-check `SUPABASE_URL` and the service key, and that the SQL ran successfully.                                                                                                                                                                      |
| The app opens but is empty or shows errors                                                      | Confirm `frontend/vercel.json` in your fork points to your backend host, then redeploy the frontend.                                                                                                                                                 |
| "The server is not responding correctly (HTTP 5xx)" or "Server not found (HTTP 404)" on sign-in | The backend is down or misconfigured. Open `APP_URL/health` and the Deno Deploy logs (a startup error such as a missing variable or a secret that is too short stops the whole backend), then check `frontend/vercel.json` points to the right host. |
| The sign-in screen appears inside Telegram                                                      | Close the Mini App and reopen it from the bot. If it persists, check that `BOT_OWNER_ID` is your own id.                                                                                                                                             |
