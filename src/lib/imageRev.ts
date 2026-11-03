import { iconUrl, thumbUrl, type Entry } from "../types/ipc";

/**
 * Content revision for icon:// / thumb:// URLs.
 *
 * Icon tokens are reused per (owner, path) and protocol responses are
 * cacheable, so a file edited in place must get a different URL to re-fetch.
 * Once an entry is hydrated its URL carries `v=<mtimeMs>-<size>`; rows that
 * render before hydration load once more when it lands (extension-shared
 * icons are cheap backend cache hits). Backend caches validate against the
 * file itself and ignore this param.
 */
export function imageRev(entry: Pick<Entry, "mtime" | "size">): string {
  if (entry.mtime == null) return "";
  return `${Math.trunc(entry.mtime)}-${entry.size ?? 0}`;
}

export function entryIconUrl(entry: Entry, size: number): string {
  return iconUrl(entry.icon, size, imageRev(entry));
}

export function entryThumbUrl(entry: Entry, size: number): string {
  return thumbUrl(entry.icon, size, imageRev(entry));
}
