/**
 * Within-app HTML5 drag & drop helpers, plus the drop-zone registry the
 * Finder drag-in bridge (lib/ipc/dnd.ts) hit-tests against.
 */
import { useOps } from "../stores/ops";

export const FAZI_DND_MIME = "application/x-fazi-paths";

/** Sidebar-favorite reorder drags — distinct MIME so rows never treat them
 *  as file moves (`dragHasPaths()` stays false). */
export const FAZI_FAV_MIME = "application/x-fazi-favorite";

/** dataTransfer isn't readable during dragover — mirror the payload here. */
let currentDragPaths: string[] | null = null;

/** Mirror of the favorite path being reorder-dragged (same dragover trick). */
let currentFavoritePath: string | null = null;

export function beginFavoriteDrag(e: React.DragEvent, path: string): void {
  currentFavoritePath = path;
  e.dataTransfer.setData(FAZI_FAV_MIME, path);
  e.dataTransfer.effectAllowed = "move";
}

export function endFavoriteDrag(): void {
  currentFavoritePath = null;
}

export function dragHasFavorite(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes(FAZI_FAV_MIME) || currentFavoritePath != null;
}

export function draggedFavoritePath(e: React.DragEvent): string | null {
  const raw = e.dataTransfer.getData(FAZI_FAV_MIME);
  return raw !== "" ? raw : currentFavoritePath;
}

export function beginInternalDrag(e: React.DragEvent, paths: string[]): void {
  currentDragPaths = paths;
  e.dataTransfer.setData(FAZI_DND_MIME, JSON.stringify(paths));
  e.dataTransfer.effectAllowed = "copyMove";
  // custom drag image with a count badge for multi-item drags
  if (paths.length > 1) {
    const badge = document.createElement("div");
    badge.textContent = String(paths.length);
    badge.style.cssText =
      "position:fixed;top:-100px;left:-100px;padding:2px 8px;border-radius:10px;" +
      "background:var(--accent);color:white;font:600 12px -apple-system;z-index:9999";
    document.body.appendChild(badge);
    e.dataTransfer.setDragImage(badge, 10, 10);
    setTimeout(() => badge.remove(), 0);
  }
}

export function endInternalDrag(): void {
  currentDragPaths = null;
}

export function dragHasPaths(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes(FAZI_DND_MIME) || currentDragPaths != null;
}

export function draggedPaths(e: React.DragEvent): string[] {
  const raw = e.dataTransfer.getData(FAZI_DND_MIME);
  if (raw) {
    try {
      return JSON.parse(raw) as string[];
    } catch {
      /* fall through */
    }
  }
  return currentDragPaths ?? [];
}

/** True if the drop would land inside one of the dragged items (or be a no-op). */
export function isInvalidDrop(paths: string[], destDir: string): boolean {
  return paths.some((p) => {
    const parent = p.slice(0, p.lastIndexOf("/")) || "/";
    return parent === destDir || destDir === p || destDir.startsWith(`${p}/`);
  });
}

/** Handle an internal drop: Opt held = copy, else move. */
export function dropPaths(e: React.DragEvent, destDir: string): void {
  const paths = draggedPaths(e);
  endInternalDrag();
  if (paths.length === 0 || isInvalidDrop(paths, destDir)) return;
  const kind = e.altKey ? "copy" : "move";
  useOps.getState().startOp({ kind, sources: paths, destDir, policy: "ask" });
}

// ---------------------------------------------------------------------------
// Drop-zone registry for Finder drag-in (real screen-coordinate hit tests)
// ---------------------------------------------------------------------------

/**
 * What a drop on a zone means. "copyTo" starts a copy into the hit directory;
 * "trash" dispatches trash_paths — dropping onto the Trash row must keep
 * Finder Trash semantics (Put Back metadata), never copy into ~/.Trash.
 */
export type DropAction = "copyTo" | "trash";

export interface DropZone {
  /** Returns the destination dir for a client point inside this zone, else null. */
  hitTest(clientX: number, clientY: number): string | null;
  /** Larger = tested first (rows beat pane background). */
  priority: number;
  /** Defaults to "copyTo". */
  action?: DropAction;
}

export interface DropHit {
  destDir: string;
  action: DropAction;
}

const dropZones = new Set<DropZone>();

export function registerDropZone(zone: DropZone): () => void {
  dropZones.add(zone);
  return () => dropZones.delete(zone);
}

export function hitTestDropZones(clientX: number, clientY: number): DropHit | null {
  const sorted = [...dropZones].sort((a, b) => b.priority - a.priority);
  for (const zone of sorted) {
    const dir = zone.hitTest(clientX, clientY);
    if (dir != null) return { destDir: dir, action: zone.action ?? "copyTo" };
  }
  return null;
}
