import { useCallback, useEffect, useState } from "react";
import { RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { api, messageOf } from "../api";
import { useDialogs } from "../components/Dialogs";
import { EmptyState, FileItem, PageHeader, SkeletonRows } from "../components/Rows";
import { useToast } from "../components/Toasts";
import { pushBack } from "../telegram";
import { useApp } from "../context";
import type { FileRow, TrashPage as TrashData } from "../types";
import { daysLeft } from "../utils";

export default function TrashPage() {
  const { navigate } = useApp();
  const toast = useToast();
  const dialogs = useDialogs();
  const [items, setItems] = useState<FileRow[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [retention, setRetention] = useState(30);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (target: number, append: boolean) => {
    setLoading(true);
    setError("");
    try {
      const result = await api<TrashData>(`/api/trash?page=${target}&limit=50`);
      setItems((
        old,
      ) => (append
        ? [...old, ...result.items.filter((item) => !old.some((existing) => existing.id === item.id))]
        : result.items)
      );
      setPage(result.page);
      setHasMore(result.has_more);
      setTotal(result.total);
      setRetention(result.retention_days);
    } catch (caught) {
      setError(messageOf(caught, "Unable to load Trash"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(1, false);
  }, [load]);
  useEffect(() => pushBack(() => navigate("files")), [navigate]);

  async function run(action: () => Promise<unknown>, fallback: string, success: string) {
    setBusy(true);
    try {
      await action();
      toast(success, { kind: "success" });
      await load(1, false);
    } catch (caught) {
      toast(messageOf(caught, fallback), { kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function deleteForever(file: FileRow) {
    const ok = await dialogs.confirm({
      title: "Delete permanently?",
      message:
        `"${file.file_name}" will be removed from your Cloud Drive and your storage channel. This cannot be undone.`,
      confirmLabel: "Delete permanently",
      danger: true,
    });
    if (ok) {
      await run(
        () => api(`/api/files/${file.id}/permanent`, { method: "DELETE" }),
        "Unable to delete file",
        "File deleted permanently",
      );
    }
  }

  async function emptyTrash() {
    const ok = await dialogs.confirm({
      title: "Empty Trash?",
      message: `All ${total} file${
        total === 1 ? "" : "s"
      } in Trash will be deleted permanently from your Cloud Drive and your storage channel. This cannot be undone.`,
      confirmLabel: "Empty Trash",
      danger: true,
    });
    if (ok) {
      await run(() => api("/api/trash/empty", { method: "POST" }), "Unable to empty Trash", "Trash emptied");
    }
  }

  return (
    <>
      <PageHeader
        title="Trash"
        description={`Files stay here for ${retention} days, then are deleted automatically.`}
        actions={
          <>
            <button type="button" className="btn" onClick={() => void load(1, false)} disabled={loading}>
              <RefreshCw size={16} aria-hidden="true" className={loading ? "spin" : undefined} />{" "}
              <span className="btn-label">Refresh</span>
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => void emptyTrash()}
              disabled={busy || total === 0}
            >
              <Trash2 size={16} aria-hidden="true" /> <span className="btn-label">Empty Trash</span>
            </button>
          </>
        }
      />
      {error && (
        <div className="banner banner-error" role="alert">
          <span>{error}</span>
          <button type="button" className="btn btn-quiet" onClick={() => void load(1, false)}>
            Try again
          </button>
        </div>
      )}
      <div className="card" aria-busy={loading}>
        {loading && <div className="progress" role="progressbar" aria-label="Loading Trash" />}
        <div className="section-label">{total} file{total === 1 ? "" : "s"} in Trash</div>
        {loading && !items.length ? <SkeletonRows /> : !items.length
          ? (
            <EmptyState
              icon={<Trash2 size={38} aria-hidden="true" />}
              title="Trash is empty"
              text="Files you delete appear here until they are removed for good."
            />
          )
          : (
            <ul className="list">
              {items.map((file) => {
                const left = daysLeft(file.deleted_at, retention);
                return (
                  <FileItem
                    key={file.id}
                    file={file}
                    date={file.deleted_at ?? file.created_at}
                    note={left === 0 ? "Deletes today" : `Deletes in ${left} day${left === 1 ? "" : "s"}`}
                    actions={
                      <>
                        <button
                          type="button"
                          className="btn"
                          disabled={busy}
                          onClick={() =>
                            void run(
                              () => api(`/api/trash/${file.id}/restore`, { method: "POST" }),
                              "Unable to restore file",
                              "File restored",
                            )}
                          aria-label={`Restore ${file.file_name}`}
                        >
                          <RotateCcw size={16} aria-hidden="true" />{" "}
                          <span className="btn-label">Restore</span>
                        </button>
                        <button
                          type="button"
                          className="btn btn-danger"
                          disabled={busy}
                          onClick={() => void deleteForever(file)}
                          aria-label={`Delete ${file.file_name} permanently`}
                        >
                          <Trash2 size={16} aria-hidden="true" /> <span className="btn-label">Delete</span>
                        </button>
                      </>
                    }
                  />
                );
              })}
            </ul>
          )}
        {hasMore && (
          <div className="load-more-wrap">
            <button
              type="button"
              className="btn"
              disabled={loading}
              onClick={() => void load(page + 1, true)}
            >
              Load more
            </button>
          </div>
        )}
      </div>
    </>
  );
}
