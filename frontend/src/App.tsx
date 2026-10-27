import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Cloud,
  Ellipsis,
  FileText,
  HardDrive,
  Link2,
  Settings as SettingsIcon,
  Star,
  Trash2,
} from "lucide-react";
import { api, ApiError, messageOf, setToken, setUnauthorizedHandler } from "./api";
import { DialogProvider } from "./components/Dialogs";
import { PopupMenu } from "./components/PopupMenu";
import { Splash } from "./components/Splash";
import { ToastProvider, useToast } from "./components/Toasts";
import { AppContext, type AppContextValue } from "./context";
import {
  initTelegram,
  onTelegramThemeChange,
  paintTelegramChrome,
  telegramInitData,
  telegramScheme,
} from "./telegram";
import type { FolderRow, Page, SessionInfo, Settings } from "./types";
import { cx } from "./utils";
import FilesPage from "./pages/FilesPage";
import LoginScreen from "./pages/LoginScreen";
import SettingsPage from "./pages/SettingsPage";
import TrashPage from "./pages/TrashPage";
import { ActivityPage, FavoritesPage, SharedPage } from "./pages/ListPages";

const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  compact_mode: false,
  default_sort: "newest",
  default_view: "list",
  confirm_delete: true,
  confirm_move: true,
  incoming_folder_id: null,
};

const NAV: Array<{ page: Page; label: string; icon: typeof FileText; more?: boolean }> = [
  { page: "files", label: "My files", icon: FileText },
  { page: "favorites", label: "Favorites", icon: Star },
  { page: "shares", label: "Shared", icon: Link2 },
  { page: "trash", label: "Trash", icon: Trash2 },
  { page: "activity", label: "Activity", icon: Activity, more: true },
  { page: "settings", label: "Settings", icon: SettingsIcon, more: true },
];

const initialPage = (): Page => {
  const view = new URLSearchParams(window.location.search).get("view");
  return NAV.some((item) => item.page === view) ? (view as Page) : "files";
};

type Phase = "loading" | "unauth" | "ready";

/** The explanation shown on the login screen when Telegram sign-in did not work. */
function telegramFailureNotice(caught: unknown): string {
  return caught instanceof ApiError && caught.status === 401
    ? "Your Telegram session is out of date. Close Cloud Drive completely and open it again from the bot."
    : `Cloud Drive could not reach its server. ${messageOf(caught, "")}`.trim();
}

function Shell() {
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>("loading");
  const [notice, setNotice] = useState<string | undefined>();
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [folders, setFolders] = useState<FolderRow[]>([]);
  const [page, setPage] = useState<Page>(initialPage);
  const firstRender = useRef(true);
  const phaseRef = useRef<Phase>("loading");
  phaseRef.current = phase;

  const reloadFolders = useCallback(async () => {
    try {
      setFolders(await api<FolderRow[]>("/api/folders?all=1"));
    } catch (caught) {
      if (!(caught instanceof ApiError && caught.status === 401)) {
        toast(messageOf(caught, "Unable to refresh folders"), { kind: "error" });
      }
    }
  }, [toast]);

  const loadAll = useCallback(async () => {
    // quiet401: signing in is handled by the caller, so a 401 here must not trigger the "session ended" handler.
    const [me, loadedSettings, loadedFolders] = await Promise.all([
      api<SessionInfo>("/api/auth/me", { quiet401: true }),
      api<Settings>("/api/settings", { quiet401: true }),
      api<FolderRow[]>("/api/folders?all=1", { quiet401: true }),
    ]);
    setSession(me);
    setSettings({ ...DEFAULT_SETTINGS, ...loadedSettings });
    setFolders(loadedFolders);
    setPhase("ready");
  }, []);

  /** A session that ended while the app was open: sign in with Telegram again (its launch data stays valid for 24 hours). */
  const recoverSession = useCallback(async (): Promise<boolean> => {
    if (phaseRef.current !== "ready") return false; // start-up and sign-out handle their own messages
    setToken(null);
    const initData = telegramInitData();
    if (!initData) {
      setNotice("Your session ended. Please sign in again.");
      setPhase("unauth");
      return false;
    }
    try {
      const result = await api<{ token: string }>("/api/auth/telegram", { method: "POST", json: { initData } });
      setToken(result.token);
      await loadAll();
      return true;
    } catch (caught) {
      setNotice(telegramFailureNotice(caught));
      setPhase("unauth");
      return false;
    }
  }, [loadAll]);

  // ---- sign-in on start: Telegram first, then an existing browser cookie.
  useEffect(() => {
    initTelegram();
    setUnauthorizedHandler(recoverSession);
    (async () => {
      const initData = telegramInitData();
      let telegramProblem: string | undefined;
      if (initData) {
        try {
          const result = await api<{ token: string }>("/api/auth/telegram", {
            method: "POST",
            json: { initData },
          });
          setToken(result.token);
        } catch (caught) {
          telegramProblem = telegramFailureNotice(caught);
        }
      }
      try {
        await loadAll();
      } catch {
        setNotice(telegramProblem);
        setPhase("unauth");
      }
    })();
    return () => setUnauthorizedHandler(null);
  }, [loadAll, recoverSession]);

  // ---- theme, density and Telegram chrome colours
  useEffect(() => {
    const apply = () => {
      const scheme = settings.theme === "system"
        ? (telegramScheme() ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"))
        : settings.theme;
      const root = document.documentElement;
      root.dataset.theme = scheme;
      root.dataset.compact = String(settings.compact_mode);
      const styles = getComputedStyle(root);
      const background = styles.getPropertyValue("--bg").trim();
      document.querySelector('meta[name="theme-color"]')?.setAttribute("content", background);
      paintTelegramChrome(background, styles.getPropertyValue("--nav-bg").trim());
    };
    apply();
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", apply);
    const offTelegram = onTelegramThemeChange(apply);
    return () => {
      media.removeEventListener("change", apply);
      offTelegram();
    };
  }, [settings.theme, settings.compact_mode]);

  // ---- move focus to the page title after navigation (screen readers and keyboards)
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    document.getElementById("page-title")?.focus();
  }, [page]);

  const saveSettings = useCallback(async (patch: Partial<Settings>) => {
    const previous = settings;
    setSettings((old) => ({ ...old, ...patch }));
    try {
      setSettings({
        ...DEFAULT_SETTINGS,
        ...(await api<Settings>("/api/settings", { method: "PATCH", json: patch })),
      });
    } catch (caught) {
      setSettings(previous);
      toast(messageOf(caught, "Unable to save settings"), { kind: "error" });
    }
  }, [settings, toast]);

  const reloadSession = useCallback(async () => {
    setSession(await api<SessionInfo>("/api/auth/me"));
  }, []);

  const signOut = useCallback(async (everywhere: boolean) => {
    let serverConfirmed = true;
    try {
      const result = await api<{ revoked?: boolean }>(
        everywhere ? "/api/auth/logout-all" : "/api/auth/logout",
        { method: "POST", quiet401: true },
      );
      serverConfirmed = result?.revoked !== false;
    } catch {
      serverConfirmed = false; // the session may already be gone, or the server could not be reached
    }
    setToken(null);
    setSession(null);
    setNotice(
      everywhere
        ? "You were signed out on every device."
        : serverConfirmed
        ? "You were signed out."
        : "You were signed out here, but the server could not confirm it. If this device is not yours, use Sign out everywhere.",
    );
    setPhase("unauth");
  }, []);

  const context = useMemo<AppContextValue | null>(() =>
    session && ({
      settings,
      saveSettings,
      folders,
      reloadFolders,
      session,
      reloadSession,
      navigate: setPage,
      signOut,
    }), [settings, saveSettings, folders, reloadFolders, session, reloadSession, signOut]);

  if (phase === "loading") return <Splash />;
  if (phase === "unauth" || !context) {
    return (
      <LoginScreen
        notice={notice}
        onSignedIn={() => {
          setNotice(undefined);
          setPhase("loading");
          loadAll().catch(() => setPhase("unauth"));
        }}
      />
    );
  }

  return (
    <AppContext.Provider value={context}>
      <a
        className="skip-link"
        href="#main"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main")?.focus();
        }}
      >
        Skip to content
      </a>
      <div className="shell">
        <aside>
          <div className="brand">
            <Cloud size={24} aria-hidden="true" />
            <b>Cloud Drive</b>
          </div>
          <nav aria-label="Main">
            {NAV.map(({ page: target, label, icon: Icon, more }) => (
              <button
                key={target}
                type="button"
                className={cx(page === target && "active", more && "nav-more-item")}
                aria-current={page === target ? "page" : undefined}
                onClick={() => setPage(target)}
                title={label}
              >
                <Icon size={20} aria-hidden="true" />
                <span className="nav-label">{label}</span>
              </button>
            ))}
            <PopupMenu
              label="More pages"
              className="nav-more-button"
              trigger={
                <>
                  <Ellipsis size={20} aria-hidden="true" />
                  <span className="nav-label">More</span>
                </>
              }
              items={NAV.filter((item) => item.more).map(({ page: target, label, icon: Icon }) => ({
                label,
                icon: <Icon size={16} aria-hidden="true" />,
                onSelect: () => setPage(target),
              }))}
            />
          </nav>
          <div className="sidefoot">
            <HardDrive size={16} aria-hidden="true" /> Telegram channel storage
          </div>
        </aside>
        <main id="main" tabIndex={-1}>
          {page === "files" && <FilesPage />}
          {page === "favorites" && <FavoritesPage />}
          {page === "shares" && <SharedPage />}
          {page === "trash" && <TrashPage />}
          {page === "activity" && <ActivityPage />}
          {page === "settings" && <SettingsPage />}
          <footer>
            <b>Cloud Drive</b> · Private Telegram-backed storage
          </footer>
        </main>
      </div>
    </AppContext.Provider>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <DialogProvider>
        <Shell />
      </DialogProvider>
    </ToastProvider>
  );
}
