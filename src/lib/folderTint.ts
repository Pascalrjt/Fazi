/**
 * Folder icons follow the accent color. The icons are macOS's own artwork,
 * so rather than redraw them, a plain folder's <img> gets the `folder-tint`
 * class and an SVG filter (FolderTintFilter) recolors it to the accent while
 * keeping its shading. Only a custom accent turns the filter on; the default
 * keeps the system's folder color.
 */
import type { Entry } from "../types/ipc";

/** Mounted volumes list as folders in /Volumes but draw as drives. */
function isVolumeRoot(path: string): boolean {
  return /^\/Volumes\/[^/]+$/.test(path);
}

/** A folder drawn with the stock folder icon (or a special-folder variant). */
export function isPlainFolder(entry: Pick<Entry, "kind" | "isPackage" | "customIcon" | "path">): boolean {
  return entry.kind === "dir" && !entry.isPackage && !entry.customIcon && !isVolumeRoot(entry.path);
}

/** Search hits carry less: a dir with an extension may be a package, and a
 *  custom icon is unknown, so this is the best guess from name and path. */
export function isPlainFolderHit(hit: { isDir: boolean; name: string; path: string }): boolean {
  const dot = hit.name.lastIndexOf(".");
  return hit.isDir && dot <= 0 && !isVolumeRoot(hit.path);
}
