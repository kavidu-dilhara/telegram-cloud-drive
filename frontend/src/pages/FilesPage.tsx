import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckSquare,
  ChevronRight,
  Copy,
  Eye,
  Folder,
  Grid2x2,
  Link2,
  List,
  Move,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Square,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { api, fetchBlobUrl, messageOf } from "../api";
import { Modal } from "../components/Modal";
import { type MenuItem, PopupMenu } from "../components/PopupMenu";
import { EmptyState, FileItem, FolderItem, PageHeader, SelectBox, SkeletonRows } from "../components/Rows";
import { useDialogs } from "../components/Dialogs";
import { useToast } from "../components/Toasts";
import { useApp } from "../context";
import { useDebounced } from "../hooks";
import { pushBack } from "../telegram";
import type { Dashboard, FavoriteRow, FileRow, FolderRow, Paged, Settings } from "../types";
import { canPreview, cx, descendants, folderOptions, formatSize, splitName } from "../utils";

const SORTS: Record<Settings["default_sort"], [string, string]> = {
  newest: ["created_at", "desc"],
  oldest: ["created_at", "asc"],
  name: ["name", "asc"],
  size: ["size", "desc"],
};

export default function FilesPage() {
  const { settings, saveSettings, folders, reloadFolders } = useApp();
  const toast = useToast();
  const dialogs = useDialogs();

  const [folderId, setFolderId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [type, setType] = useState("");
  const [extension, setExtension] = useState("");
  const [sort, setSort] = useState<Settings["default_sort"]>(settings.default_sort);
  const debouncedQuery = useDebounced(query.trim());
  const debouncedExtension = useDebounced(extension.trim().replace(/^\./, ""));

  const [items, setItems] = useState<FileRow[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [stats, setStats] = useState<Dashboard | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [selectedFolders, setSelectedFolders] = useState<Set<string>>(new Set());
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<FileRow | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const requestId = useRef(0);

  const filtering = Boolean(debouncedQuery || type || debouncedExtension);
  const params = useMemo(() => {
    const search = new URLSearchParams({ folder_id: folderId ?? "root", limit: "50" });
    if (debouncedQuery) {
      search.set("q", debouncedQuery);
      search.set("global", "1");
    }
    if (type) search.set("type", type);
    if (debouncedExtension) search.set("extension", debouncedExtension);
    const [key, direction] = SORTS[sort];
    search.set("sort", key);
    search.set("direction", direction);
    return search.toString();
  }, [folderId, debouncedQuery, type, debouncedExtension, sort]);

  // Load the first page whenever the view changes. A newer request always wins over an older one.
  useEffect(() => {
    const id = ++requestId.current;
    setLoadingMore(false);
    setLoading(true);
    setError("");
    setSelectedFiles(new Set());
    setSelectedFolders(new Set());
    api<Paged<FileRow>>(`/api/files?${params}&page=1`)
      .then((result) => {
        if (id !== requestId.current) return;
        setItems(result.items);
        setPage(1);
        setHasMore(result.has_more);
        setTotal(result.total);
      })
      .catch((caught) => id === requestId.current && setError(messageOf(caught, "Unable to load files")))
      .finally(() => id === requestId.current && setLoading(false));
    api<Dashboard>("/api/dashboard").then(setStats).catch(() => undefined);
  }, [params, reloadKey]);

  useEffect(() => {
    api<FavoriteRow[]>("/api/favorites")
      .then((rows) => setFavoriteIds(new Set(rows.map((row) => row.file_id))))
      .catch(() => undefined);
  }, []);

  // Telegram's Back button walks up the folder tree.
  const parentOfCurrent = folders.find((folder) => folder.id === folderId)?.parent_id ?? null;
  useEffect(() => (folderId ? pushBack(() => setFolderId(parentOfCurrent)) : undefined), [
    folderId,
    parentOfCurrent,
  ]);

  useEffect(() => {
    if (!preview) return;
    let url: string | null = null;
    let cancelled = false;
    setPreviewUrl(null);
    setPreviewFailed(false);
    fetchBlobUrl(`/api/files/${preview.id}/preview`)
      .then((value) => {
        if (cancelled) URL.revokeObjectURL(value);
        else {
          url = value;
          setPreviewUrl(value);
        }
      })
      .catch(() => !cancelled && setPreviewFailed(true));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [preview]);

  const refresh = useCallback(() => {
    setReloadKey((key) => key + 1);
    void reloadFolders();
  }, [reloadFolders]);

  async function attempt(action: () => Promise<unknown>, fallback: string, success?: string) {
    try {
      await action();
      if (success) toast(success, { kind: "success" });
      refresh();
      return true;
    } catch (caught) {
      toast(messageOf(caught, fallback), { kind: "error" });
      return false;
    }
  }

  async function loadMore() {
    const id = requestId.current; // the view this request belongs to
    setLoadingMore(true);
    try {
      const result = await api<Paged<FileRow>>(`/api/files?${params}&page=${page + 1}`);
      if (id !== requestId.current) return; // the folder, search or filters changed meanwhile
      setItems((
        old,
      ) => [...old, ...result.items.filter((item) => !old.some((existing) => existing.id === item.id))]);
      setPage(result.page);
      setHasMore(result.has_more);
    } catch (caught) {
      if (id === requestId.current) toast(messageOf(caught, "Unable to load more files"), { kind: "error" });
    } finally {
      if (id === requestId.current) setLoadingMore(false);
    }
  }

  // ----------------------------------------------------------- folder actions
  const visibleFolders = useMemo(
    () => (filtering ? [] : folders.filter((folder) => folder.parent_id === folderId)),
    [folders, folderId, filtering],
  );
  const breadcrumbs = useMemo(() => {
    const trail: FolderRow[] = [];
    let cursor = folderId;
    while (cursor) {
      const folder = folders.find((item) => item.id === cursor);
      if (!folder) break;
      trail.unshift(folder);
      cursor = folder.parent_id;
    }
    return trail;
  }, [folders, folderId]);
  const currentFolder = breadcrumbs.at(-1);

  async function createFolder() {
    const name = await dialogs.prompt({
      title: "New folder",
      label: "Folder name",
      confirmLabel: "Create folder",
    });
    if (name) {
      await attempt(
        () => api("/api/folders", { method: "POST", json: { name, parent_id: folderId } }),
        "Unable to create folder",
        "Folder created",
      );
    }
  }

  async function renameFolder(folder: FolderRow) {
    const name = await dialogs.prompt({
      title: "Rename folder",
      label: "Folder name",
      initial: folder.name,
      confirmLabel: "Rename",
    });
    if (name && name !== folder.name) {
      await attempt(
        () => api(`/api/folders/${folder.id}`, { method: "PATCH", json: { name } }),
        "Unable to rename folder",
        "Folder renamed",
      );
    }
  }

  async function deleteFolders(list: FolderRow[]) {
    if (settings.confirm_delete) {
      const names = list.length === 1 ? `"${list[0].name}"` : `${list.length} folders`;
      const ok = await dialogs.confirm({
        title: list.length === 1 ? "Delete folder?" : "Delete folders?",
        message:
          `${names} will be deleted. The files and folders inside move up to the parent folder, nothing is lost.`,
        confirmLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
    }
    await attempt(
      async () => {
        for (const folder of list) await api(`/api/folders/${folder.id}`, { method: "DELETE" });
        if (folderId && list.some((folder) => folder.id === folderId)) {
          setFolderId(
            list.find((folder) => folder.id === folderId)!.parent_id,
          );
        }
      },
      "Unable to delete folder",
      list.length === 1 ? "Folder deleted" : "Folders deleted",
    );
  }

  async function moveFolders(list: FolderRow[], copy: boolean) {
    const exclude = new Set<string>();
    if (!copy) list.forEach((folder) => descendants(folder.id, folders).forEach((id) => exclude.add(id)));
    const choice = await dialogs.pickFolder({
      title: copy ? "Copy folder" : "Move folder",
      message: list.length === 1
        ? `Choose where "${list[0].name}" should go.`
        : `Choose where ${list.length} folders should go.`,
      options: folderOptions(folders, exclude),
      confirmLabel: copy ? "Copy here" : "Move here",
    });
    if (!choice) return;
    await attempt(
      async () => {
        for (const folder of list) {
          if (copy) {
            await api(`/api/folders/${folder.id}/copy`, {
              method: "POST",
              json: { parent_id: choice.id },
            });
          } else {await api(`/api/folders/${folder.id}`, {
              method: "PATCH",
              json: { parent_id: choice.id },
            });}
        }
        setSelectedFolders(new Set());
      },
      copy ? "Unable to copy folder" : "Unable to move folder",
      copy ? "Folder copied" : "Folder moved",
    );
  }

  // ------------------------------------------------------------- file actions
  async function renameFile(file: FileRow) {
    const { base, ext } = splitName(file.file_name);
    const name = await dialogs.prompt({
      title: "Rename file",
      label: "File name",
      initial: base,
      suffix: ext,
      hint: ext ? `The extension ${ext} is kept automatically.` : undefined,
      confirmLabel: "Rename",
    });
    if (name && name !== base) {
      await attempt(
        () => api(`/api/files/${file.id}`, { method: "PATCH", json: { file_name: name } }),
        "Unable to rename file",
        "File renamed",
      );
    }
  }

  async function shareFile(file: FileRow) {
    try {
      const result = await api<{ url: string }>(`/api/files/${file.id}/share`, { method: "POST" });
      await dialogs.showLink({ title: "Share link", url: result.url, text: file.file_name });
    } catch (caught) {
      toast(messageOf(caught, "Unable to create share link"), { kind: "error" });
    }
  }

  async function moveOrCopyFiles(ids: string[], copy: boolean, exclude?: string | null) {
    const choice = await dialogs.pickFolder({
      title: copy ? "Copy files" : "Move files",
      message: ids.length === 1 ? undefined : `${ids.length} files selected.`,
      options: folderOptions(folders, exclude ? new Set([exclude]) : new Set()),
      confirmLabel: copy ? "Copy here" : "Move here",
    });
    if (!choice) return false;
    return attempt(
      () =>
        api(`/api/files/batch/${copy ? "copy" : "move"}`, {
          method: "POST",
          json: { file_ids: ids, folder_id: choice.id },
        }),
      copy ? "Unable to copy files" : "Unable to move files",
      copy ? "Copied" : "Moved",
    );
  }

  async function trashFiles(ids: string[], label: string) {
    if (settings.confirm_delete) {
      const ok = await dialogs.confirm({
        title: "Move to Trash?",
        message: `${label} will move to Trash. You can restore it for ${
          stats?.trashRetentionDays ?? 30
        } days.`,
        confirmLabel: "Move to Trash",
        danger: true,
      });
      if (!ok) return;
    }
    const done = await attempt(
      () => api("/api/files/batch/trash", { method: "POST", json: { file_ids: ids } }),
      "Unable to move to Trash",
    );
    if (done) {
      toast(`Moved ${ids.length === 1 ? "1 file" : `${ids.length} files`} to Trash`, {
        kind: "success",
        action: {
          label: "Undo",
          run: () =>
            void attempt(
              () => api("/api/files/batch/restore", { method: "POST", json: { file_ids: ids } }),
              "Unable to undo",
              "Restored",
            ),
        },
      });
    }
  }

  async function toggleFavorite(file: FileRow) {
    const active = favoriteIds.has(file.id);
    setFavoriteIds((old) => {
      const next = new Set(old);
      if (active) next.delete(file.id);
      else next.add(file.id);
      return next;
    });
    try {
      await api(`/api/files/${file.id}/favorite`, { method: active ? "DELETE" : "POST" });
    } catch (caught) {
      setFavoriteIds((old) => {
        const next = new Set(old);
        if (active) next.add(file.id);
        else next.delete(file.id);
        return next;
      });
      toast(messageOf(caught, "Unable to update favorite"), { kind: "error" });
    }
  }

  // --------------------------------------------------------------- selection
  const toggle = (setter: typeof setSelectedFiles, id: string) =>
    setter((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const everythingSelected = items.length + visibleFolders.length > 0 &&
    items.every((file) => selectedFiles.has(file.id)) &&
    visibleFolders.every((folder) => selectedFolders.has(folder.id));
  const toggleAll = () => {
    if (everythingSelected) {
      setSelectedFiles(new Set());
      setSelectedFolders(new Set());
    } else {
      setSelectedFiles(new Set(items.map((file) => file.id)));
      setSelectedFolders(new Set(visibleFolders.map((folder) => folder.id)));
    }
  };
  const clearSelection = () => {
    setSelectedFiles(new Set());
    setSelectedFolders(new Set());
  };
  const chosenFolders = folders.filter((folder) => selectedFolders.has(folder.id));
  const selectionLabel = [
    selectedFiles.size ? `${selectedFiles.size} file${selectedFiles.size === 1 ? "" : "s"}` : "",
    selectedFolders.size ? `${selectedFolders.size} folder${selectedFolders.size === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(" and ");

  async function moveSelected(copy: boolean) {
    if (settings.confirm_move) {
      const ok = await dialogs.confirm({
        title: copy ? "Copy selected items?" : "Move selected items?",
        message: `${selectionLabel} will be ${copy ? "copied" : "moved"}. Pick the destination next.`,
        confirmLabel: "Continue",
      });
      if (!ok) return;
    }
    if (selectedFiles.size && chosenFolders.length) {
      toast("Select either files or folders to move or copy at once.", { kind: "info" });
      return;
    }
    if (selectedFiles.size) {
      if (await moveOrCopyFiles([...selectedFiles], copy)) clearSelection();
    } else {
      await moveFolders(chosenFolders, copy);
    }
  }

  const fileMenu = (file: FileRow): MenuItem[] => [
    { label: "Rename", icon: <Pencil size={16} aria-hidden="true" />, onSelect: () => void renameFile(file) },
    {
      label: "Preview",
      icon: <Eye size={16} aria-hidden="true" />,
      hidden: !canPreview(file),
      onSelect: () => setPreview(file),
    },
    { label: "Share", icon: <Link2 size={16} aria-hidden="true" />, onSelect: () => void shareFile(file) },
    {
      label: "Copy",
      icon: <Copy size={16} aria-hidden="true" />,
      onSelect: () => void moveOrCopyFiles([file.id], true),
    },
    {
      label: "Move",
      icon: <Move size={16} aria-hidden="true" />,
      onSelect: () => void moveOrCopyFiles([file.id], false, folderId),
    },
    {
      label: "Move to Trash",
      icon: <Trash2 size={16} aria-hidden="true" />,
      danger: true,
      onSelect: () => void trashFiles([file.id], `"${file.file_name}"`),
    },
  ];
  const folderMenu = (folder: FolderRow): MenuItem[] => [
    {
      label: "Rename",
      icon: <Pencil size={16} aria-hidden="true" />,
      onSelect: () => void renameFolder(folder),
    },
    {
      label: "Copy",
      icon: <Copy size={16} aria-hidden="true" />,
      onSelect: () => void moveFolders([folder], true),
    },
    {
      label: "Move",
      icon: <Move size={16} aria-hidden="true" />,
      onSelect: () => void moveFolders([folder], false),
    },
    {
      label: "Delete",
      icon: <Trash2 size={16} aria-hidden="true" />,
      danger: true,
      onSelect: () => void deleteFolders([folder]),
    },
  ];

  const empty = !loading && !items.length && !visibleFolders.length;
  const view = settings.default_view;

  return (
    <>
      <PageHeader
        title={currentFolder?.name ?? "My files"}
        description="Organize your files without leaving Telegram."
        actions={
          <button type="button" className="btn" onClick={refresh} disabled={loading}>
            <RefreshCw size={16} aria-hidden="true" className={loading ? "spin" : undefined} />{" "}
            <span className="btn-label">Refresh</span>
          </button>
        }
      />

      <section className="stats" aria-label="Library summary">
        <article>
          <span>Files</span>
          <strong>{stats?.count ?? "–"}</strong>
        </article>
        <article>
          <span>Space used</span>
          <strong>{stats ? formatSize(stats.bytes) : "–"}</strong>
        </article>
        <article>
          <span>Folders</span>
          <strong>{stats?.folderCount ?? "–"}</strong>
        </article>
        <article>
          <span>In Trash</span>
          <strong>{stats?.trashCount ?? "–"}</strong>
        </article>
      </section>

      <div className="toolbar">
        <div className="search">
          <Search size={18} aria-hidden="true" />
          <input
            aria-label="Search all files by name"
            placeholder="Search all files…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button
              type="button"
              className="icon-button"
              aria-label="Clear search"
              onClick={() => setQuery("")}
            >
              <X size={16} aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="toolbar-actions">
          <button type="button" className="btn" onClick={() => void createFolder()}>
            <Plus size={16} aria-hidden="true" /> <span className="btn-label">New folder</span>
          </button>
          <button type="button" className="btn" onClick={toggleAll} aria-pressed={everythingSelected}>
            {everythingSelected
              ? <Square size={16} aria-hidden="true" />
              : <CheckSquare size={16} aria-hidden="true" />}
            <span className="btn-label">{everythingSelected ? "Deselect all" : "Select all"}</span>
          </button>
          <button
            type="button"
            className="btn btn-square"
            aria-label={view === "grid" ? "Switch to list view" : "Switch to grid view"}
            onClick={() => void saveSettings({ default_view: view === "grid" ? "list" : "grid" })}
          >
            {view === "grid"
              ? <List size={18} aria-hidden="true" />
              : <Grid2x2 size={18} aria-hidden="true" />}
          </button>
        </div>
      </div>

      <div className="filterbar">
        <select aria-label="File type" value={type} onChange={(event) => setType(event.target.value)}>
          <option value="">All types</option>
          <option value="image">Images</option>
          <option value="video">Videos</option>
          <option value="audio">Audio</option>
          <option value="document">Documents</option>
        </select>
        <input
          aria-label="File extension"
          value={extension}
          onChange={(event) => setExtension(event.target.value)}
          placeholder="Extension (pdf, zip…)"
        />
        <select
          aria-label="Sort files"
          value={sort}
          onChange={(event) => setSort(event.target.value as Settings["default_sort"])}
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="name">Name A–Z</option>
          <option value="size">Largest first</option>
        </select>
        {(query || type || extension) && (
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => {
              setQuery("");
              setType("");
              setExtension("");
            }}
          >
            <X size={14} aria-hidden="true" /> Clear filters
          </button>
        )}
      </div>

      <nav className="breadcrumbs" aria-label="Folder path">
        <button
          type="button"
          onClick={() => setFolderId(null)}
          aria-current={folderId === null ? "page" : undefined}
          className={cx(folderId === null && "current")}
        >
          My files
        </button>
        {breadcrumbs.map((folder) => (
          <span key={folder.id}>
            <ChevronRight size={14} aria-hidden="true" />
            <button
              type="button"
              onClick={() => setFolderId(folder.id)}
              aria-current={folder.id === folderId ? "page" : undefined}
              className={cx(folder.id === folderId && "current")}
            >
              {folder.name}
            </button>
          </span>
        ))}
      </nav>
      {debouncedQuery && (
        <p className="scope-note" role="status">Showing results from all folders for “{debouncedQuery}”.</p>
      )}

      {selectedFiles.size + selectedFolders.size > 0 && (
        <div className="selection-bar" role="region" aria-label="Selected items">
          <b>{selectionLabel} selected</b>
          <div className="selection-actions">
            <button
              type="button"
              onClick={() =>
                void moveSelected(false)}
            >
              <Move size={15} aria-hidden="true" /> Move
            </button>
            <button
              type="button"
              onClick={() =>
                void moveSelected(true)}
            >
              <Copy size={15} aria-hidden="true" /> Copy
            </button>
            {selectedFiles.size > 0 && (
              <button
                type="button"
                className="danger"
                onClick={() =>
                  void trashFiles(
                    [...selectedFiles],
                    `${selectedFiles.size} file${selectedFiles.size === 1 ? "" : "s"}`,
                  ).then(clearSelection)}
              >
                <Trash2 size={15} aria-hidden="true" /> Trash {selectedFiles.size === 1 ? "file" : "files"}
              </button>
            )}
            {selectedFolders.size > 0 && (
              <button
                type="button"
                className="danger"
                onClick={() => void deleteFolders(chosenFolders).then(clearSelection)}
              >
                <Trash2 size={15} aria-hidden="true" /> Delete{" "}
                {selectedFolders.size === 1 ? "folder" : "folders"}
              </button>
            )}
            <button
              type="button"
              className="icon-button on-dark"
              aria-label="Clear selection"
              onClick={clearSelection}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="banner banner-error" role="alert">
          <span>{error}</span>
          <button type="button" className="btn btn-quiet" onClick={refresh}>Try again</button>
        </div>
      )}

      <div className="card" aria-busy={loading}>
        {loading && <div className="progress" role="progressbar" aria-label="Loading files" />}
        <div className="section-label">
          {filtering
            ? `${total} matching file${total === 1 ? "" : "s"}`
            : currentFolder
            ? "Folder contents"
            : "Top level"}
        </div>
        {loading && !items.length && !visibleFolders.length ? <SkeletonRows /> : empty
          ? (
            <EmptyState
              icon={<Folder size={38} aria-hidden="true" />}
              title={filtering ? "No files match" : "This folder is empty"}
              text={filtering
                ? "Try a different search or clear the filters."
                : "Create a folder, or send a file to your Telegram bot."}
            />
          )
          : (
            <ul className={cx("list", view === "grid" && "grid-view")}>
              {visibleFolders.map((folder) => (
                <FolderItem
                  key={folder.id}
                  name={folder.name}
                  selected={selectedFolders.has(folder.id)}
                  onSelect={() => toggle(setSelectedFolders, folder.id)}
                  onOpen={() => setFolderId(folder.id)}
                  actions={
                    <PopupMenu label={`Actions for folder ${folder.name}`} items={folderMenu(folder)} />
                  }
                />
              ))}
              {items.map((file) => (
                <FileItem
                  key={file.id}
                  file={file}
                  leading={
                    <SelectBox
                      checked={selectedFiles.has(file.id)}
                      onChange={() => toggle(setSelectedFiles, file.id)}
                      label={`Select ${file.file_name}`}
                    />
                  }
                  actions={
                    <>
                      <button
                        type="button"
                        className={cx("favorite-button", favoriteIds.has(file.id) && "is-favorite")}
                        aria-pressed={favoriteIds.has(file.id)}
                        aria-label={favoriteIds.has(file.id)
                          ? `Remove ${file.file_name} from Favorites`
                          : `Add ${file.file_name} to Favorites`}
                        onClick={() => void toggleFavorite(file)}
                      >
                        <Star
                          size={18}
                          aria-hidden="true"
                          fill={favoriteIds.has(file.id) ? "currentColor" : "none"}
                        />
                      </button>
                      <PopupMenu label={`Actions for ${file.file_name}`} items={fileMenu(file)} />
                    </>
                  }
                />
              ))}
            </ul>
          )}
        {hasMore && (
          <div className="load-more-wrap">
            <button type="button" className="btn" disabled={loadingMore} onClick={() => void loadMore()}>
              {loadingMore ? "Loading…" : "Load more files"}
            </button>
          </div>
        )}
      </div>

      {preview && (
        <Modal title={preview.file_name} onClose={() => setPreview(null)} wide>
          <div className="preview-frame">
            {!previewUrl && !previewFailed && (
              <div className="progress" role="progressbar" aria-label="Loading preview" />
            )}
            {previewFailed
              ? (
                <EmptyState
                  icon={<Eye size={32} aria-hidden="true" />}
                  title="Preview unavailable"
                  text="Telegram could not provide this image right now. Try again later."
                />
              )
              : (
                previewUrl && <img src={previewUrl} alt={preview.file_name} />
              )}
          </div>
          <p className="hint">Image preview · {formatSize(Number(preview.file_size))}</p>
        </Modal>
      )}
    </>
  );
}
