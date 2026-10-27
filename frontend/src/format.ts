/** Human-readable size. Values that round up to the next unit move to it ("1.00 MB", never "1024 KB"). */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kilobytes = Math.round(bytes / 1024);
  if (kilobytes < 1024) return `${Math.max(1, kilobytes)} KB`;
  const megabytes = bytes / 1048576;
  if (Number(megabytes.toFixed(2)) < 1024) return `${megabytes.toFixed(2)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}
