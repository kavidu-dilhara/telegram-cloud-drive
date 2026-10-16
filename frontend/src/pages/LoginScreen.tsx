import { type FormEvent, useEffect, useState } from "react";
import { Cloud, Eye, EyeOff } from "lucide-react";
import { api, messageOf, setToken } from "../api";

interface Props {
  notice?: string;
  onSignedIn: () => void;
}

export default function LoginScreen({ notice, onSignedIn }: Props) {
  const [passwordEnabled, setPasswordEnabled] = useState<boolean | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [attempt, setAttempt] = useState(0);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    setOffline(false);
    setError("");
    api<{ password_enabled: boolean }>("/api/auth/method")
      .then((result) => setPasswordEnabled(result.password_enabled))
      .catch((caught) => {
        setPasswordEnabled(false);
        setOffline(true);
        setError(messageOf(caught, "Cannot reach the server"));
      });
  }, [attempt]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ token: string }>("/api/auth/password/login", {
        method: "POST",
        json: { username, password },
      });
      setToken(result.token);
      setPassword("");
      onSignedIn();
    } catch (caught) {
      setError(messageOf(caught, "Sign-in failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-screen" id="main">
      <div className="auth-card">
        <div className="auth-logo">
          <Cloud size={28} aria-hidden="true" />
        </div>
        <h1>Cloud Drive</h1>
        <p className="auth-lead">Your private files, stored in your own Telegram channel.</p>
        {notice && <div className="banner banner-info" role="status">{notice}</div>}
        {passwordEnabled
          ? (
            <form onSubmit={(event) => void submit(event)} className="stack">
              <label className="field">
                <span>Username</span>
                <input
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                />
              </label>
              <label className="field">
                <span>Password</span>
                <span className="input-suffix">
                  <input
                    type={visible ? "text" : "password"}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="current-password"
                    required
                  />
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={visible ? "Hide password" : "Show password"}
                    aria-pressed={visible}
                    onClick={() => setVisible(!visible)}
                  >
                    {visible ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
                  </button>
                </span>
              </label>
              {error && <div className="banner banner-error" role="alert">{error}</div>}
              <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
                {busy ? "Signing in…" : "Sign in"}
              </button>
            </form>
          )
          : passwordEnabled === false
          ? (
            <>
              {error && <div className="banner banner-error" role="alert">{error}</div>}
              {offline
                ? (
                  <button type="button" className="btn btn-primary btn-block" onClick={() => setAttempt((value) => value + 1)}>
                    Try again
                  </button>
                )
                : (
                  <p className="auth-lead">
                    Open Cloud Drive from your Telegram bot to sign in. You can enable password sign-in for
                    browsers later in Settings.
                  </p>
                )}
            </>
          )
          : <p className="auth-lead" role="status">Loading…</p>}
      </div>
    </main>
  );
}
