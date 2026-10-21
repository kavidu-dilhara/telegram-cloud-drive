# Changelog

## Unreleased

**Security**

- Per-address login throttling no longer trusts forwarding headers by default. Set `TRUSTED_IP_HEADER` (and
  `TRUSTED_PROXY_HOPS`) only if your host overwrites them; `X-Forwarded-For` is read from the right.
- Login throttling fails closed: if the failure counters cannot be read or written, sign-in answers 503
  instead of skipping the limit, and the error is logged.
- Sign-out everywhere and credential changes now revoke sessions immediately on every backend instance (the
  5-second session-version cache is gone). If the version cannot be read, requests answer 503 instead of
  falling back to version 1.
- JSON request bodies are capped (16 KB for sign-in routes, 64 KB elsewhere) and answer 413 before parsing.
- Image previews are limited to PNG, JPEG, GIF and WebP. SVG is no longer served inline, and preview responses
  carry a sandboxing Content-Security-Policy.
- State-changing API requests (POST, PATCH, DELETE) must now carry an allowed `Origin` header, or be marked
  same-origin by the browser (`Sec-Fetch-Site`). Reads are unchanged. Scripts calling the API with a token
  must send `Origin` set to your Mini App URL.
- Settings only accept the app's own keys (names such as `constructor` are rejected).

**Fixes**

- Deleting a folder now moves the whole folder (all subfolders and files) to Trash as one item. Nothing is
  left behind in My Files. The Trash shows the folder with its file and subfolder counts and where it was;
  Restore rebuilds the exact tree (same folders, same names, every file back in its original folder) and
  Delete removes everything inside permanently, including the stored Telegram messages no other file uses. If
  the original parent is gone the folder returns to the top level, and if the name is taken it is restored as
  "name (restored)". Restoring a single file puts it back in its original folder (top level only if that
  folder no longer exists). Emptying Trash and the automatic cleanup include deleted folders. Re-run
  `supabase/schema.sql` to update the database.
- A database failure while reading the owner account (sign-in, login screen, settings) now answers 503 with a
  retry hint instead of "invalid credentials" or "password sign-in is off", and is not counted as a failed
  sign-in attempt.
- The Trash list pages through every deleted folder and file (it was cut off at 200 folders). Telegram
  `/trash` says how many more folders there are when it cannot list them all.
- Older password hashes keep working after an upgrade: the iteration count column no longer defaults to the
  new work factor (so rows hashed before it existed stay at the original 210,000), and sign-in also recognises
  rows an earlier version of the schema had mislabelled. Re-run `supabase/schema.sql`.
- Sign-in attempts are now counted atomically before the slow password check, so a burst of parallel guesses
  can no longer slip past the limit. Successful sign-ins do not use up the shared limit.
- Telegram albums share one status message that shows how every file went, including failures.
- Telegram `/favorites` pages and counts only favorites of active files, so pages are never short or
  misnumbered.
- When the Mini App session expires (12 hours) it signs in again with Telegram and repeats the request,
  instead of dead-ending on the login screen. The useful Telegram sign-in message is no longer replaced by
  "Your session ended".
- A folder can no longer be copied into itself or one of its subfolders, and copying a folder is safe even if
  the folder hierarchy is ever damaged. Re-run `supabase/schema.sql` to update the database function.
- Only one share link per file is enforced by the database. Re-running `supabase/schema.sql` removes older
  duplicate links (the oldest is kept) and adds the unique index.
- Telegram `/favorite` and `/favorites` now list favorites in pages, with a button to remove each one.
- "Load more files" no longer adds results from an earlier folder, search or filter.

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
