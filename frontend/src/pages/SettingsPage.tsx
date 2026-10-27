import { type FormEvent, useCallback, useEffect, useState } from "react";
import { CheckCircle2, CircleAlert, LogOut, RefreshCw } from "lucide-react";
import { api, messageOf, setToken } from "../api";
import { useDialogs } from "../components/Dialogs";
import { PageHeader } from "../components/Rows";
import { useToast } from "../components/Toasts";
import { useApp } from "../context";
import { pushBack } from "../telegram";
import { APP_VERSION, type Settings, type StatusReport } from "../types";
import { folderOptions, formatDate } from "../utils";

function Toggle(
  { label, hint, checked, onChange }: {
    label: string;
    hint?: string;
    checked: boolean;
    onChange: (value: boolean) => void;
  },
) {
  return (
    <label className="setting-row">
      <span>
        <b>{label}</b>
        {hint && <small>{hint}</small>}
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

function StatusRow({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <div className="status-row">
      <span>{label}</span>
      <span className={ok ? "status-good" : "status-bad"}>
        {ok ? <CheckCircle2 size={16} aria-hidden="true" /> : <CircleAlert size={16} aria-hidden="true" />}
        <b>{ok ? "OK" : "Problem"}</b>
        <small>{detail}</small>
      </span>
    </div>
  );
}

export default function SettingsPage() {
  const { settings, saveSettings, folders, session, reloadSession, navigate, signOut } = useApp();
  const toast = useToast();
  const dialogs = useDialogs();
  const [status, setStatus] = useState<StatusReport | null>(null);
  const [statusError, setStatusError] = useState("");
  const [checking, setChecking] = useState(false);
  const [roundTrip, setRoundTrip] = useState<number | null>(null);
  const [username, setUsername] = useState(session.username ?? "");
  const [password, setPassword] = useState("");
  const [current, setCurrent] = useState("");
  const [formError, setFormError] = useState("");
  const [now, setNow] = useState(() => Date.now());

  // Opening Settings refreshes the session details, and the clock keeps the "recent sign-in" window up to date.
  useEffect(() => {
    void reloadSession().catch(() => undefined);
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [reloadSession]);
  const [saving, setSaving] = useState(false);

  useEffect(() => pushBack(() => navigate("files")), [navigate]);

  // Live checks: every row comes from the backend measuring the real service on request.
  const check = useCallback(async () => {
    setChecking(true);
    setStatusError("");
    try {
      const started = performance.now();
      const report = await api<StatusReport>("/api/status");
      setRoundTrip(Math.round(performance.now() - started));
      setStatus(report);
    } catch (caught) {
      setStatusError(messageOf(caught, "Unable to run the status checks"));
    } finally {
      setChecking(false);
    }
  }, []);
  useEffect(() => {
    void check();
  }, [check]);

  const change = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    saveSettings({ [key]: value } as Partial<Settings>);

  async function submitCredentials(event: FormEvent) {
    event.preventDefault();
    setFormError("");
    setSaving(true);
    try {
      const body = session.password_enabled
        ? await api<{ token: string }>("/api/auth/password", {
          method: "PATCH",
          json: { username, password, current_password: current || undefined },
        })
        : await api<{ token: string }>("/api/auth/password/setup", {
          method: "POST",
          json: { username, password },
        });
      setToken(body.token);
      setPassword("");
      setCurrent("");
      await reloadSession();
      toast(
        session.password_enabled
          ? "Credentials updated. Other devices were signed out."
          : "Browser sign-in enabled",
        { kind: "success" },
      );
    } catch (caught) {
      setFormError(messageOf(caught, "Unable to save credentials"));
    } finally {
      setSaving(false);
    }
  }

  async function leaveEverywhere() {
    const ok = await dialogs.confirm({
      title: "Sign out everywhere?",
      message:
        "Every signed-in browser and device, including this one, is signed out. Telegram sign-in keeps working.",
      confirmLabel: "Sign out everywhere",
      danger: true,
    });
    if (ok) await signOut(true);
  }

  // Whether the app was opened from Telegram a few minutes ago. Counted down on the screen (not fetched once at
  // launch), so the "Current password" field appears exactly when the server starts asking for it.
  const recent = session.recent_sign_in_until != null && now < session.recent_sign_in_until;
  const needsCurrent = session.password_enabled && !recent;

  async function unlockSignIn() {
    try {
      const result = await api<{ cleared: number }>("/api/auth/unlock-signin", { method: "POST" });
      toast(result.cleared ? "Sign-in limits reset" : "No sign-in limits were active", { kind: "success" });
    } catch (caught) {
      toast(messageOf(caught, "Unable to reset the sign-in limits"), { kind: "error" });
    }
  }

  return (
    <>
      <PageHeader title="Settings" description="Appearance, behaviour, security and live service status." />
      <div className="settings-grid">
        <section className="settings-card" aria-labelledby="set-appearance">
          <h2 id="set-appearance">Appearance</h2>
          <label className="field">
            <span>Theme</span>
            <select
              value={settings.theme}
              onChange={(event) => void change("theme", event.target.value as Settings["theme"])}
            >
              <option value="system">Match Telegram / device</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <label className="field">
            <span>Default view</span>
            <select
              value={settings.default_view}
              onChange={(event) =>
                void change("default_view", event.target.value as Settings["default_view"])}
            >
              <option value="list">List</option>
              <option value="grid">Grid</option>
            </select>
          </label>
          <label className="field">
            <span>Default sort</span>
            <select
              value={settings.default_sort}
              onChange={(event) =>
                void change("default_sort", event.target.value as Settings["default_sort"])}
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="name">Name A–Z</option>
              <option value="size">Largest first</option>
            </select>
          </label>
          <Toggle
            label="Compact rows"
            hint="Fit more files on screen"
            checked={settings.compact_mode}
            onChange={(value) => void change("compact_mode", value)}
          />
        </section>

        <section className="settings-card" aria-labelledby="set-behaviour">
          <h2 id="set-behaviour">Behaviour</h2>
          <Toggle
            label="Confirm before deleting"
            hint="Asks before moving files to Trash or deleting folders"
            checked={settings.confirm_delete}
            onChange={(value) => void change("confirm_delete", value)}
          />
          <Toggle
            label="Confirm before moving"
            hint="Asks before moving or copying a selection"
            checked={settings.confirm_move}
            onChange={(value) => void change("confirm_move", value)}
          />
          <label className="field">
            <span>Folder for new files sent to the bot</span>
            <select
              value={settings.incoming_folder_id ?? ""}
              onChange={(event) => void change("incoming_folder_id", event.target.value || null)}
            >
              {folderOptions(folders).map((option) => (
                <option key={option.id ?? "root"} value={option.id ?? ""}>{option.label}</option>
              ))}
            </select>
          </label>
        </section>

        <section className="settings-card" aria-labelledby="set-security">
          <h2 id="set-security">Account and security</h2>
          <p className="hint">
            Signed in with {session.via === "telegram" ? "Telegram" : "your password"}. This session ends{" "}
            {formatDate(session.session_expires_at)}.
          </p>
          <form onSubmit={(event) => void submitCredentials(event)} className="stack">
            <h3>{session.password_enabled ? "Change browser credentials" : "Enable browser sign-in"}</h3>
            {!session.password_enabled && !recent && (
              <div className="banner" role="note">
                For your security, turning on browser sign-in needs a recent Telegram sign-in. Close Cloud Drive and open
                it again from the bot, then come back here.
              </div>
            )}
            <label className="field">
              <span>Username</span>
              <input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
                minLength={3}
                maxLength={64}
                pattern="[A-Za-z0-9._\-]+"
                required
              />
            </label>
            {needsCurrent && (
              <label className="field">
                <span>Current password</span>
                <input
                  type="password"
                  value={current}
                  onChange={(event) => setCurrent(event.target.value)}
                  autoComplete="current-password"
                  required
                />
              </label>
            )}
            <label className="field">
              <span>New password</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                minLength={12}
                maxLength={256}
                required
              />
              <small className="hint">
                At least 12 characters. Changing it signs out your other devices.
              </small>
            </label>
            {formError && <div className="banner banner-error" role="alert">{formError}</div>}
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving
                ? "Saving…"
                : session.password_enabled
                ? "Update credentials"
                : "Enable browser sign-in"}
            </button>
          </form>
          <div className="button-row">
            <button type="button" className="btn" onClick={() => void signOut(false)}>
              <LogOut size={16} aria-hidden="true" /> Sign out
            </button>
            <button type="button" className="btn btn-danger" onClick={() => void leaveEverywhere()}>
              Sign out everywhere
            </button>
            {session.password_enabled && recent && (
              <button type="button" className="btn" onClick={() => void unlockSignIn()}>
                Reset sign-in lockout
              </button>
            )}
          </div>
        </section>

        <section className="settings-card" aria-labelledby="set-status">
          <div className="card-title-row">
            <h2 id="set-status">Live status</h2>
            <button type="button" className="btn" onClick={() => void check()} disabled={checking}>
              <RefreshCw size={16} aria-hidden="true" className={checking ? "spin" : undefined} /> Refresh
            </button>
          </div>
          {statusError && <div className="banner banner-error" role="alert">{statusError}</div>}
          {!status && !statusError && <p className="hint" role="status">Checking services…</p>}
          {status && (
            <div role="status" aria-live="polite">
              <StatusRow label="This app" ok detail={`Version ${APP_VERSION}`} />
              <StatusRow
                label="Backend"
                ok={status.backend.ok}
                detail={[
                  `Version ${status.backend.version}`,
                  status.backend.region ? `region ${status.backend.region}` : null,
                  status.backend.deployment ? `build ${status.backend.deployment}` : null,
                  roundTrip !== null ? `answered in ${roundTrip} ms` : null,
                ].filter(Boolean).join(" · ")}
              />
              <StatusRow
                label="Database"
                ok={status.database.ok}
                detail={status.database.ok
                  ? `${status.database.latency_ms} ms`
                  : status.database.error ?? "Unreachable"}
              />
              <StatusRow
                label="Telegram bot"
                ok={status.telegram.ok}
                detail={status.telegram.ok
                  ? `@${status.telegram.bot_username ?? "bot"} · ${status.telegram.latency_ms} ms`
                  : status.telegram.error ?? "Unreachable"}
              />
              <StatusRow
                label="Webhook"
                ok={status.webhook.ok}
                detail={status.webhook.error ?? (!status.webhook.url_set
                  ? "Not registered. Run deno task webhook"
                  : !status.webhook.callbacks_allowed
                  ? "Buttons are blocked: re-run deno task webhook"
                  : status.webhook.last_error ?? `${status.webhook.pending_updates ?? 0} pending`)}
              />
              <StatusRow
                label="Storage channel"
                ok={status.channel.ok}
                detail={status.channel.error ?? (status.channel.ok
                  ? `${status.channel.title ?? "Channel"} · bot is ${status.channel.bot_role}`
                  : "The bot cannot post to the channel")}
              />
              <StatusRow
                label="Session"
                ok
                detail={`${session.via === "telegram" ? "Telegram" : "Password"} · expires ${
                  formatDate(session.session_expires_at)
                }`}
              />
              <p className="hint">
                Checked {formatDate(status.checked_at)}. Trash is emptied after {status.retention.trash_days}
                {" "}
                days and activity after {status.retention.activity_days} days.
              </p>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
