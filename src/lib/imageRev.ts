import { iconUrl, thumbUrl, type Entry } from "../types/ipc";

/**
 * Content revision for icon:// / thumb:// URLs.
 *
 * Icon tokens are reused per (owner, path) and protocol responses are
 * cacheable, so a file changed in place must get a different URL to re-fetch.
 * Hydration supplies `rev` (inode, size, mtime/ctime in ns — ctime covers
 * FinderInfo / xattr changes); the backend icon memo also uses it to answer
 * without a stat. Entries from older payloads without `rev` fall back to
 * mtime+size. Unhydrated rows carry no revision.
 */
export function imageRev(entry: Pick<Entry, "mtime" | "size" | "rev">): string {
  if (entry.rev) return entry.rev;
  if (entry.mtime == null) return "";
  return `${Math.trunc(entry.mtime)}-${entry.size ?? 0}`;
}

export function entryIconUrl(entry: Entry, size: number): string {
  return iconUrl(entry.icon, size, imageRev(entry));
}

export function entryThumbUrl(entry: Entry, size: number): string {
  return thumbUrl(entry.icon, size, imageRev(entry));
}
