import { type ReactNode, useEffect, useState } from "react";
import { Activity, Copy, Link2, Send, Star, Trash2, X } from "lucide-react";
import { api, messageOf } from "../api";
import { copyText, useDialogs } from "../components/Dialogs";
import { EmptyState, PageHeader, SkeletonRows } from "../components/Rows";
import { useToast } from "../components/Toasts";
import { useApp } from "../context";
import { pushBack, shareViaTelegram } from "../telegram";
import type { ActivityRow, FavoriteRow, ShareRow } from "../types";
import { actionLabel, formatDate, formatSize } from "../utils";

/** Loads a list once and exposes it with loading/error state and a setter for optimistic updates. */
function useList<T>(path: string, pick: (raw: unknown) => T[]) {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [extra, setExtra] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const { navigate } = useApp();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<unknown>(path)
      .then((raw) => {
        if (cancelled) return;
        setItems(pick(raw));
        const retention = (raw as { retention_days?: number }).retention_days;
        setExtra(typeof retention === "number" ? retention : null);
        setError("");
      })
      .catch((caught) => !cancelled && setError(messageOf(caught, "Unable to load this list")))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // `pick` is a stable inline function per page; the path and reload key are the real inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, reloadKey]);

  useEffect(() => pushBack(() => navigate("files")), [navigate]);
  return { items, setItems, loading, error, extra, reload: () => setReloadKey((key) => key + 1) };
}

function ListShell({ title, description, loading, error, onRetry, children, actions }: {
  title: string;
  description: string;
  loading: boolean;
  error: string;
  onRetry: () => void;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <>
      <PageHeader title={title} description={description} actions={actions} />
      {error && (
        <div className="banner banner-error" role="alert">
          <span>{error}</span>
          <button type="button" className="btn btn-quiet" onClick={onRetry}>Try again</button>
        </div>
      )}
      <div className="card" aria-busy={loading}>
        {loading && <div className="progress" role="progressbar" aria-label={`Loading ${title}`} />}
        {loading ? <SkeletonRows /> : children}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ favorites
export function FavoritesPage() {
  const toast = useToast();
  const { items, setItems, loading, error, reload } = useList<FavoriteRow>(
    "/api/favorites",
    (raw) => raw as FavoriteRow[],
  );

  async function remove(favorite: FavoriteRow) {
    try {
      await api(`/api/files/${favorite.file_id}/favorite`, { method: "DELETE" });
      setItems((old) => old.filter((item) => item.id !== favorite.id));
      toast("Removed from Favorites", { kind: "success" });
    } catch (caught) {
      toast(messageOf(caught, "Unable to remove favorite"), { kind: "error" });
    }
  }

  return (
    <ListShell
      title="Favorites"
      description="Files you starred for quick access."
      loading={loading}
      error={error}
      onRetry={reload}
    >
      {items.length === 0
        ? (
          <EmptyState
            icon={<Star size={38} aria-hidden="true" />}
            title="No favorites yet"
            text="Tap the star next to a file to keep it here."
          />
        )
        : (
          <ul className="list">
            {items.map((favorite) => (
              <li className="row" key={favorite.id}>
                <span className="file-icon">
                  <Star size={20} aria-hidden="true" />
                </span>
                <div className="row-info">
                  <b>{favorite.file.file_name}</b>
                  <small>{formatSize(Number(favorite.file.file_size))}</small>
                </div>
                <div className="row-actions">
                  <button
                    type="button"
                    className="btn btn-quiet"
                    onClick={() => void remove(favorite)}
                    aria-label={`Remove ${favorite.file.file_name} from Favorites`}
                  >
                    <X size={16} aria-hidden="true" /> <span className="btn-label">Remove</span>
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
    </ListShell>
  );
}

// --------------------------------------------------------------------- shared
export function SharedPage() {
  const toast = useToast();
  const dialogs = useDialogs();
  const { items, setItems, loading, error, reload } = useList<ShareRow>(
    "/api/shares",
    (raw) => raw as ShareRow[],
  );

  async function revoke(share: ShareRow) {
    const ok = await dialogs.confirm({
      title: "Revoke link?",
      message: `The link to "${share.file.file_name}" will stop working for everyone who has it.`,
      confirmLabel: "Revoke link",
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/shares/${share.id}`, { method: "DELETE" });
      setItems((old) => old.filter((item) => item.id !== share.id));
      toast("Link revoked", { kind: "success" });
    } catch (caught) {
      toast(messageOf(caught, "Unable to revoke link"), { kind: "error" });
    }
  }

  return (
    <ListShell
      title="Shared links"
      description="Anyone with a link can receive the file from your bot."
      loading={loading}
      error={error}
      onRetry={reload}
    >
      {items.length === 0
        ? (
          <EmptyState
            icon={<Link2 size={38} aria-hidden="true" />}
            title="No shared links"
            text="Open a file's menu and choose Share to create one."
          />
        )
        : (
          <ul className="list">
            {items.map((share) => (
              <li className="row" key={share.id}>
                <span className="file-icon">
                  <Link2 size={20} aria-hidden="true" />
                </span>
                <div className="row-info">
                  <b>{share.file.file_name}</b>
                  <small className="wrap">
                    {share.url ?? "Link unavailable. Revoke it and share the file again."}
                  </small>
                </div>
                <div className="row-actions">
                  {share.url && (
                    <>
                      <button
                        type="button"
                        className="btn btn-square"
                        aria-label={`Copy link to ${share.file.file_name}`}
                        onClick={async () =>
                          toast(
                            (await copyText(share.url!))
                              ? "Link copied"
                              : "Copy is blocked here. Open Share to copy it manually.",
                            { kind: "info" },
                          )}
                      >
                        <Copy size={16} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="btn btn-square"
                        aria-label={`Send link to ${share.file.file_name} in Telegram`}
                        onClick={() => shareViaTelegram(share.url!, share.file.file_name)}
                      >
                        <Send size={16} aria-hidden="true" />
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={() => void revoke(share)}
                    aria-label={`Revoke link to ${share.file.file_name}`}
                  >
                    <X size={16} aria-hidden="true" /> <span className="btn-label">Revoke</span>
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
    </ListShell>
  );
}

// ------------------------------------------------------------------- activity
export function ActivityPage() {
  const toast = useToast();
  const dialogs = useDialogs();
  const { items, setItems, loading, error, extra, reload } = useList<ActivityRow>(
    "/api/activity",
    (raw) => (raw as { items: ActivityRow[] }).items,
  );

  async function clear() {
    const ok = await dialogs.confirm({
      title: "Clear activity?",
      message: "All activity records will be deleted. Your files are not affected.",
      confirmLabel: "Clear activity",
      danger: true,
    });
    if (!ok) return;
    try {
      await api("/api/activity", { method: "DELETE" });
      setItems([]);
      toast("Activity cleared", { kind: "success" });
    } catch (caught) {
      toast(messageOf(caught, "Unable to clear activity"), { kind: "error" });
    }
  }

  return (
    <ListShell
      title="Activity"
      description={`Recent actions. Entries are removed automatically after ${extra ?? 30} days.`}
      loading={loading}
      error={error}
      onRetry={reload}
      actions={
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => void clear()}
          disabled={!items.length}
        >
          <Trash2 size={16} aria-hidden="true" /> <span className="btn-label">Clear activity</span>
        </button>
      }
    >
      {items.length === 0
        ? <EmptyState icon={<Activity size={38} aria-hidden="true" />} title="No activity yet" />
        : (
          <ul className="list">
            {items.map((entry) => (
              <li className="row" key={entry.id}>
                <span className="file-icon">
                  <Activity size={20} aria-hidden="true" />
                </span>
                <div className="row-info">
                  <b>{actionLabel(entry.action)}</b>
                  <small className="wrap">
                    {[entry.file_name, formatDate(entry.created_at)].filter(Boolean).join(" · ")}
                  </small>
                </div>
              </li>
            ))}
          </ul>
        )}
    </ListShell>
  );
}
