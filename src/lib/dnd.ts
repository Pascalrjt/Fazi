/**
 * Within-app HTML5 drag & drop helpers, plus the drop-zone registry the
 * Finder drag-in bridge (lib/ipc/dnd.ts) hit-tests against, plus the pure
 * state machine for native drag-out sessions (tauri-plugin-drag).
 */
import { useOps } from "../stores/ops";
import { trashPathsWithUndo } from "./actions";

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

// ---------------------------------------------------------------------------
// Native drag-out session state (tauri-plugin-drag)
// ---------------------------------------------------------------------------
//
// While a native drag is in flight, HTML5 drag events don't fire — the bridge
// (lib/ipc/dnd.ts) and the plugin completion callback consult this state to
// tell self-drops (→ internal move, ⌥ copy) from Finder drags (→ copy).

let nativeDragPaths: string[] | null = null;
let nativeDropHandled = false;
let altDuringDrag = false;

export function beginNativeDragState(paths: string[], altHeld: boolean): void {
  nativeDragPaths = paths;
  nativeDropHandled = false;
  altDuringDrag = altHeld;
}

/** MUST run on every session end — completion callback AND startDrag
 *  rejection — or a stale flag turns the next Finder drag-in into a move. */
export function endNativeDragState(): void {
  nativeDragPaths = null;
  nativeDropHandled = false;
  altDuringDrag = false;
}

export function nativeDragPathsNow(): string[] | null {
  return nativeDragPaths;
}

/** The bridge marks the drop consumed so the plugin's completion-callback
 *  fallback never dispatches the same drop twice. */
export function markNativeDropHandled(): void {
  nativeDropHandled = true;
}

export function wasNativeDropHandled(): boolean {
  return nativeDropHandled;
}

export function setAltDuringDrag(v: boolean): void {
  altDuringDrag = v;
}

export function altHeldDuringDrag(): boolean {
  return altDuringDrag;
}

/** Apply a native self-drop at a hit zone: trash rows trash, folders get an
 *  internal move (⌥ held = copy). Same no-op guards as HTML5 drops. */
export function dispatchNativeSelfDrop(hit: DropHit, paths: string[], altCopy: boolean): void {
  if (paths.length === 0) return;
  if (hit.action === "trash") {
    trashPathsWithUndo(paths);
    return;
  }
  if (isInvalidDrop(paths, hit.destDir)) return;
  useOps.getState().startOp({
    kind: altCopy ? "copy" : "move",
    sources: paths,
    destDir: hit.destDir,
    policy: "ask",
  });
}

/** PNG data URL for the native drag image: a document glyph with a count
 *  badge. The plugin needs a data URL or real file path — a bundled asset's
 *  dev-server URL is not a usable native image path. */
export function dragImageDataUrl(count: number): string {
  const scale = window.devicePixelRatio || 1;
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size * scale;
  canvas.height = size * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas.toDataURL("image/png");
  ctx.scale(scale, scale);
  // Document sheet with a folded corner.
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.strokeStyle = "rgba(0,0,0,0.25)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(18, 8);
  ctx.lineTo(38, 8);
  ctx.lineTo(46, 16);
  ctx.lineTo(46, 54);
  ctx.lineTo(18, 54);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(38, 8);
  ctx.lineTo(38, 16);
  ctx.lineTo(46, 16);
  ctx.stroke();
  if (count > 1) {
    const label = count > 99 ? "99+" : String(count);
    ctx.font = "600 12px -apple-system, sans-serif";
    const w = Math.max(18, ctx.measureText(label).width + 10);
    ctx.fillStyle = "#e0383e";
    ctx.beginPath();
    ctx.roundRect(size - w - 2, 2, w, 18, 9);
    ctx.fill();
    ctx.fillStyle = "white";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, size - 2 - w / 2, 11);
  }
  return canvas.toDataURL("image/png");
}
