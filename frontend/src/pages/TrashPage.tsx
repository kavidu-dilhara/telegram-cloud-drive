import { useCallback, useEffect, useState } from "react";
import { FolderOpen, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { api, messageOf } from "../api";
import { useDialogs } from "../components/Dialogs";
import { EmptyState, FileItem, PageHeader, SkeletonRows } from "../components/Rows";
import { useToast } from "../components/Toasts";
import { pushBack } from "../telegram";
import { useApp } from "../context";
import type { FileRow, TrashedFolder, TrashPage as TrashData } from "../types";
import { daysLeft, formatDate } from "../utils";

/** "3 files, 2 subfolders" for a deleted folder item. */
function describeFolder(folder: TrashedFolder): string {
  const files = `${folder.file_count} file${folder.file_count === 1 ? "" : "s"}`;
  const subfolders = folder.folder_count - 1;
  return subfolders > 0 ? `${files}, ${subfolders} subfolder${subfolders === 1 ? "" : "s"}` : files;
}

export default function TrashPage() {
  const { navigate } = useApp();
  const toast = useToast();
  const dialogs = useDialogs();
  const [items, setItems] = useState<FileRow[]>([]);
  const [folders, setFolders] = useState<TrashedFolder[]>([]);
  const [folderTotal, setFolderTotal] = useState(0);
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
      setFolders((current) => {
        const next = result.folders ?? [];
        if (!append) return next;
        const known = new Set(current.map((folder) => folder.id));
        return [...current, ...next.filter((folder) => !known.has(folder.id))];
      });
      setFolderTotal(result.folder_total ?? 0);
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

  async function run<T>(action: () => Promise<T>, fallback: string, success: string | ((result: T) => string)) {
    setBusy(true);
    try {
      const result = await action();
      toast(typeof success === "function" ? success(result) : success, { kind: "success" });
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

  async function restoreFile(file: FileRow) {
    await run(
      () => api<{ moved_to_root?: boolean }>(`/api/trash/${file.id}/restore`, { method: "POST" }),
      "Unable to restore file",
      (result) =>
        result?.moved_to_root
          ? "File restored to My Files (its original folder no longer exists)"
          : "File restored",
    );
  }

  async function restoreFolder(folder: TrashedFolder) {
    await run(
      () =>
        api<{ name: string; restored_files: number; renamed: boolean; moved_to_root: boolean }>(
          `/api/trash/folders/${folder.id}/restore`,
          { method: "POST" },
        ),
      "Unable to restore folder",
      (result) => {
        if (result?.renamed) return `Folder restored as "${result.name}" (that name was already in use)`;
        if (result?.moved_to_root) return "Folder restored to My Files (its original location no longer exists)";
        const files = result?.restored_files ?? folder.file_count;
        return `Folder restored with ${files} file${files === 1 ? "" : "s"}`;
      },
    );
  }

  async function deleteFolderForever(folder: TrashedFolder) {
    const ok = await dialogs.confirm({
      title: "Delete folder permanently?",
      message: `"${folder.name}" and everything inside it (${describeFolder(folder)}) will be removed from your ` +
        "Cloud Drive and your storage channel. This cannot be undone.",
      confirmLabel: "Delete permanently",
      danger: true,
    });
    if (ok) {
      await run(
        () => api(`/api/trash/folders/${folder.id}`, { method: "DELETE" }),
        "Unable to delete folder",
        "Folder deleted permanently",
      );
    }
  }

  const itemCount = total + folderTotal;

  async function emptyTrash() {
    const ok = await dialogs.confirm({
      title: "Empty Trash?",
      message: `Everything in Trash (${itemCount} item${
        itemCount === 1 ? "" : "s"
      }) will be deleted permanently from your Cloud Drive and your storage channel. This cannot be undone.`,
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
        description={`Files and folders stay here for ${retention} days, then are deleted automatically.`}
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
              disabled={busy || itemCount === 0}
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
        <div className="section-label">{itemCount} item{itemCount === 1 ? "" : "s"} in Trash</div>
        {loading && !items.length && !folders.length ? <SkeletonRows /> : !items.length && !folders.length
          ? (
            <EmptyState
              icon={<Trash2 size={38} aria-hidden="true" />}
              title="Trash is empty"
              text="Files and folders you delete appear here until they are removed for good."
            />
          )
          : (
            <ul className="list">
              {folders.map((folder) => {
                const left = daysLeft(folder.deleted_at, retention);
                const parent = folder.path.includes("/") ? folder.path.slice(0, folder.path.lastIndexOf("/")) : "";
                return (
                  <li className="row" key={folder.id}>
                    <span className="folder-icon">
                      <FolderOpen size={20} aria-hidden="true" />
                    </span>
                    <div className="row-info">
                      <b>{folder.name}</b>
                      <small>
                        {[
                          `Folder · ${describeFolder(folder)}`,
                          `from ${parent || "My Files"}`,
                          formatDate(folder.deleted_at),
                          left === 0 ? "Deletes today" : `Deletes in ${left} day${left === 1 ? "" : "s"}`,
                        ].join(" · ")}
                      </small>
                    </div>
                    <div className="row-actions">
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={() => void restoreFolder(folder)}
                        aria-label={`Restore folder ${folder.name}`}
                      >
                        <RotateCcw size={16} aria-hidden="true" /> <span className="btn-label">Restore</span>
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger"
                        disabled={busy}
                        onClick={() => void deleteFolderForever(folder)}
                        aria-label={`Delete folder ${folder.name} permanently`}
                      >
                        <Trash2 size={16} aria-hidden="true" /> <span className="btn-label">Delete</span>
                      </button>
                    </div>
                  </li>
                );
              })}
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
                          onClick={() => void restoreFile(file)}
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
