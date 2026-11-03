import { iconUrl, thumbUrl, type Entry } from "../types/ipc";

/**
 * Content revisions for icon:// / thumb:// URLs.
 *
 * Icon tokens are reused per (owner, path), and the protocol responses are
 * cacheable, so a file edited in place would keep its stale image. The URL
 * therefore carries `v=<mtimeMs>-<size>` once the content differs from what
 * the token was first seen with. The first hydrated revision per token is the
 * baseline and adds no param: rows render before hydration (mtime null), and
 * flipping every row's URL at hydration would fetch each image twice.
 */
const baselines = new Map<string, string>();
const CAP = 100_000;

function revKey(mtime: number, size: number | null): string {
  return `${Math.trunc(mtime)}-${size ?? 0}`;
}

/** URL revision for `entry`'s images ("" = the token's baseline content). */
export function imageRev(entry: Pick<Entry, "icon" | "mtime" | "size">): string {
  if (entry.mtime == null) return "";
  const key = revKey(entry.mtime, entry.size);
  const base = baselines.get(entry.icon);
  if (base === undefined) {
    if (baselines.size >= CAP) {
      // Oldest-first (Map keeps insertion order).
      const drop = baselines.keys().next().value;
      if (drop !== undefined) baselines.delete(drop);
    }
    baselines.set(entry.icon, key);
    return "";
  }
  return base === key ? "" : key;
}

export function entryIconUrl(entry: Entry, size: number): string {
  return iconUrl(entry.icon, size, imageRev(entry));
}

export function entryThumbUrl(entry: Entry, size: number): string {
  return thumbUrl(entry.icon, size, imageRev(entry));
}

/** Tests only. */
export function _resetImageRevs(): void {
  baselines.clear();
}
