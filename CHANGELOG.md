# Changelog

## Unreleased

**Security**

- Per-address login throttling no longer trusts forwarding headers by default. Set `TRUSTED_IP_HEADER` (and
  `TRUSTED_PROXY_HOPS`) only if your host overwrites them; `X-Forwarded-For` is read from the right.
- Login throttling fails closed: if the failure counters cannot be read or written, sign-in answers 503
  instead of skipping the limit, and the error is logged.
- JSON request bodies are capped (16 KB for sign-in routes, 64 KB elsewhere) and answer 413 before parsing.

## 1.0.0

First public release.

**Features**

- Save any file, photo, video, audio or voice message by sending it to your Telegram bot. Albums are handled
  and duplicates are detected.
- Mini App with nested folders, rename, move, copy, bulk select, favourites, list and grid view, search,
  filters and sorting.
- Trash with Undo and restore, automatic purge after 30 days (configurable), manual Empty Trash and Clear
  activity.
- One revocable share link per file; recipients receive the file from your bot.
- Image preview for files under 2 MB.
- Bot commands: `/app`, `/files`, `/storage`, `/newfolder` (creates nested paths), `/trash`, `/favorite`,
  `/favorites`, `/shared`, `/settings`, `/help`.
- Live status page that checks the database, bot, webhook and storage channel for real.
- Branded loading screen, light / dark / Telegram theme, accessible dialogs and menus, WCAG AA contrast.

**Security**

- Telegram sign-in with signed launch data (valid for 24 hours), optional browser password with PBKDF2
  (600,000 iterations).
- Revocable sessions: sign out, sign out everywhere, automatic on password change.
- Database-backed login rate limiting; current password required to change credentials.
- Share tokens encrypted at rest (AES-GCM); webhook secret checked in constant time.
- Content-Security-Policy and security headers; database functions callable only with the service-role key.
