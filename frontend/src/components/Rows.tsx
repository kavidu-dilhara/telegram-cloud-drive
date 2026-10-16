import type { ReactNode } from "react";
import {
  Archive,
  File as FileGeneric,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Image,
  Music2,
  Video,
} from "lucide-react";
import type { FileRow } from "../types";
import { cx, extensionOf, formatDate, formatSize } from "../utils";

export function FileTypeIcon({ file }: { file: FileRow }) {
  const ext = (file.extension || extensionOf(file.file_name).slice(1)).toLowerCase();
  const mime = file.mime_type?.toLowerCase() ?? "";
  const props = { size: 20, "aria-hidden": true } as const;
  if (mime.startsWith("image/")) return <Image {...props} />;
  if (mime.startsWith("video/") || ["mp4", "mov", "mkv", "webm"].includes(ext)) return <Video {...props} />;
  if (mime.startsWith("audio/") || ["mp3", "wav", "m4a", "ogg", "flac"].includes(ext)) {
    return <Music2 {...props} />;
  }
  if (ext === "pdf" || ["doc", "docx", "txt", "md", "rtf"].includes(ext)) return <FileText {...props} />;
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return <Archive {...props} />;
  if (["xls", "xlsx", "csv"].includes(ext)) return <FileSpreadsheet {...props} />;
  return <FileGeneric {...props} />;
}

/** Checkbox with a 44px touch area and a proper accessible name. */
export function SelectBox(
  { checked, onChange, label }: { checked: boolean; onChange: () => void; label: string },
) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span className="sr-only">{label}</span>
    </label>
  );
}

interface FileItemProps {
  file: FileRow;
  leading?: ReactNode;
  actions: ReactNode;
  /** Extra text after the size and date, e.g. "Deletes in 12 days". */
  note?: string;
  date?: string;
}

export function FileItem({ file, leading, actions, note, date }: FileItemProps) {
  return (
    <li className="row">
      {leading}
      <span className="file-icon">
        <FileTypeIcon file={file} />
      </span>
      <div className="row-info">
        <b>{file.file_name}</b>
        <small>
          {[formatSize(Number(file.file_size)), formatDate(date ?? file.created_at), note].filter(Boolean)
            .join(" · ")}
        </small>
      </div>
      <div className="row-actions">{actions}</div>
    </li>
  );
}

interface FolderItemProps {
  name: string;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  actions: ReactNode;
}

export function FolderItem({ name, selected, onSelect, onOpen, actions }: FolderItemProps) {
  return (
    <li className={cx("row", "folder-row")}>
      <SelectBox checked={selected} onChange={onSelect} label={`Select folder ${name}`} />
      <button type="button" className="row-main" onClick={onOpen} aria-label={`Open folder ${name}`}>
        <span className="folder-icon">
          <FolderOpen size={20} aria-hidden="true" />
        </span>
        <span className="row-info">
          <b>{name}</b>
          <small>Folder</small>
        </span>
      </button>
      <div className="row-actions">{actions}</div>
    </li>
  );
}

export function PageHeader(
  { title, description, actions }: { title: string; description?: string; actions?: ReactNode },
) {
  return (
    <header className="page-header">
      <div>
        <div className="eyebrow">Private Telegram storage</div>
        <h1 tabIndex={-1} id="page-title">{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="header-actions">{actions}</div>}
    </header>
  );
}

export function EmptyState({ icon, title, text }: { icon: ReactNode; title: string; text?: string }) {
  return (
    <div className="empty">
      {icon}
      <b>{title}</b>
      {text && <span>{text}</span>}
    </div>
  );
}

export function SkeletonRows({ count = 5 }: { count?: number }) {
  return (
    <ul className="list" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <li className="row skeleton-row" key={index}>
          <span className="skeleton skeleton-icon" />
          <span className="skeleton skeleton-line" />
        </li>
      ))}
    </ul>
  );
}
