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
- Image previews work for file names in any language (the old header made names such as `ස.png` fail with a
  500).
- Renaming a file keeps its extension even when the extension has no Latin letters or digits, and typing the
  extension yourself never duplicates it, whatever its length.
- Copying a folder with a very long name no longer fails: the copy's name is shortened to fit the
  100-character limit.
- `?type=` on the file list only accepts the real types, and `page` / `limit` are always whole numbers.
- A slow Telegram update is acknowledged after 25 seconds and finishes in the background, instead of answering
  500 and making Telegram send it again.
- Cancelling a delete keeps your selection, a failed batch action refreshes the list, and a mixed selection is
  reported before the confirmation dialog. A new dialog cancels the one it replaces.
- Bot buttons always stop their spinner when an action fails, and Telegram's "message is not modified" is no
  longer reported as a failure.
- A database outage during Telegram sign-in now answers 503 ("temporarily unavailable") instead of telling you
  your Telegram session is out of date.
- Folder, setting and duplicate checks no longer swallow database errors: during an outage an upload fails
  with a "send it again" message instead of landing in the wrong folder or skipping duplicate detection.
- "Sign out everywhere" and credential changes are single atomic database steps and can no longer silently do
  nothing. Re-run `supabase/schema.sql`.
- Image previews also renew an expired session. The unused `register_login_failure` function is removed.
- **Sign out really signs out.** Every session now has its own id, and "Sign out" revokes that session on the
  server (before, the token stayed valid for up to 12 hours). If the server cannot confirm it, the app says
  so. Re-run `supabase/schema.sql`.
- **The bot token can no longer leak into logs.** Network errors carry the request URL, which contains the
  token; all error logging now removes the bot token and the other secrets, and the image preview catches its
  own Telegram failures.
- **Permanent deletes answer immediately.** The database queues the channel messages it orphans in the same
  step that removes the files, so none can be forgotten, and they are deleted in the background (Telegram
  allows about 20 per minute in a channel). Failures are retried with a growing delay. Emptying a big Trash no
  longer times out or reports a failure after the data is already gone.
- A failed lookup of the destination folder no longer leaves an orphaned copy in the storage channel: the
  folder is chosen before anything is copied, and any later failure removes (or queues the removal of) the
  copy.
- Settings counts down the "recent Telegram sign-in" window itself and refreshes when you open it, so the
  "Current password" field appears exactly when the server asks for it, and the message says what is needed.
- New optional `SHARE_SECRET` encrypts stored share links, so `SESSION_SECRET` can be changed without breaking
  them (links made earlier keep working).
- "Reset sign-in lockout" in Settings (after a recent Telegram sign-in) clears the password sign-in limits.
- Sizes just under a unit boundary show as "1.00 MB", never "1024 KB".
- **Security:** old Telegram launch data no longer counts as a recent sign-in. A session remembers when
  Telegram launched the Mini App, and turning on browser sign-in or changing credentials without the current
  password needs a launch within the last 10 minutes (reopen the app from the bot first). Sign-in itself still
  accepts launch data for 24 hours, so an open app keeps renewing its session.
- "Select all" works for any number of files: the app sends long selections in groups of 100, and the server
  talks to the database in groups too.
- The type and extension filters search every folder, like text search, instead of showing only the current
  folder with no way into subfolders.
- The webhook status no longer stays red forever: only a delivery error from the last hour counts.
- A database problem while opening a share link is reported as a problem to retry, not as "no longer valid".
- Storage-channel messages that cannot be deleted are remembered and retried by the maintenance job (and given
  up on after 10 tries) instead of staying in the channel forever. Re-run `supabase/schema.sql`.
- A typed `*` in search no longer matches arbitrary text. `/files` and `/trash` in the bot show the last page
  when the page number is too high. Cancelling or finishing a delete only clears the selection it concerns.
- The file list without a `folder_id` means the top level (like the folder list); only `global=1` searches
  everywhere. File renames report database errors as 503. Every file now has a MIME type (the Documents filter
  relies on it). Empty Trash reports the deleted folders it removed too. Failed maintenance cleanup is logged.
  Album status messages no longer send identical edits. Bot buttons tapped by a stranger are answered. Prompt
  dialogs start empty and keep what you typed when you click outside. The move dialog leaves out the folder
  the files are really in. Favorite stars refresh when the app comes back to the foreground.
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
