/**
 * Within-app HTML5 drag & drop helpers, plus the drop-zone registry the
 * Finder drag-in bridge (lib/ipc/dnd.ts) hit-tests against.
 */
import { useOps } from "../stores/ops";

export const FAZI_DND_MIME = "application/x-fazi-paths";

/** dataTransfer isn't readable during dragover — mirror the payload here. */
let currentDragPaths: string[] | null = null;

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

export interface DropZone {
  /** Returns the destination dir for a client point inside this zone, else null. */
  hitTest(clientX: number, clientY: number): string | null;
  /** Larger = tested first (rows beat pane background). */
  priority: number;
}

const dropZones = new Set<DropZone>();

export function registerDropZone(zone: DropZone): () => void {
  dropZones.add(zone);
  return () => dropZones.delete(zone);
}

export function hitTestDropZones(clientX: number, clientY: number): string | null {
  const sorted = [...dropZones].sort((a, b) => b.priority - a.priority);
  for (const zone of sorted) {
    const dir = zone.hitTest(clientX, clientY);
    if (dir != null) return dir;
  }
  return null;
}
