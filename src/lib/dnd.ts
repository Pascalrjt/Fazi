/**
 * Drag & drop core: the drop-zone registry every drag flavor hit-tests
 * against (Finder drag-in, native self-drops, internal pointer drags), the
 * drag-hover broadcast + spring-load manager, and the pure state machine for
 * native drag-out sessions (tauri-plugin-drag).
 *
 * There is deliberately NO HTML5 drag & drop here. With Tauri's
 * dragDropEnabled (the default, and required for Finder drag-in), wry
 * swallows the WKWebView's NSDraggingDestination callbacks, so the DOM never
 * receives dragover/drop for ANY drag on macOS — HTML5 drop targets are dead
 * in the running app. Rows keep `draggable` purely as the gesture trigger;
 * the drag itself is a native session (lib/ipc/dnd.ts) or a pointer drag
 * (lib/pointerDrag.ts). Sidebar-favorite reorder is pointer-based too.
 */
import { useOps } from "../stores/ops";
import { trashPathsWithUndo } from "./actions";
import { pinFolders } from "./pin";

/** True if the drop would land inside one of the dragged items (or be a no-op). */
export function isInvalidDrop(paths: string[], destDir: string): boolean {
  return paths.some((p) => {
    const parent = p.slice(0, p.lastIndexOf("/")) || "/";
    return parent === destDir || destDir === p || destDir.startsWith(`${p}/`);
  });
}

// ---------------------------------------------------------------------------
// Drop-zone registry for Finder drag-in (real screen-coordinate hit tests)
// ---------------------------------------------------------------------------

/** A zone hit that should spring-open its directory after a hover dwell.
 *  `key` identifies the hovered target (same key = same dwell); `open`
 *  navigates the hovering pane's tab. Background zones carry no spring. */
export interface SpringSpec {
  key: string;
  open(): void;
}

/**
 * What a drop on a zone means. "copyTo" starts a copy into the hit directory;
 * "trash" dispatches trash_paths — dropping onto the Trash row must keep
 * Finder Trash semantics (Put Back metadata), never copy into ~/.Trash;
 * "pin" adds dropped folders to the sidebar Favorites at `index`.
 * `targetKey` identifies the specific hovered element (row/cell/crumb) so it
 * can render a drop ring; pane backgrounds omit it.
 */
export type DropHit =
  | { action: "copyTo"; destDir: string; targetKey?: string; spring?: SpringSpec }
  | { action: "trash"; destDir: string; targetKey?: string }
  | { action: "pin"; index: number };

export interface DropZone {
  /** Returns what a drop at this client point means, else null. */
  hitTest(clientX: number, clientY: number): DropHit | null;
  /** Larger = tested first (rows beat pane background). */
  priority: number;
}

const dropZones = new Set<DropZone>();

export function registerDropZone(zone: DropZone): () => void {
  dropZones.add(zone);
  return () => dropZones.delete(zone);
}

export function hitTestDropZones(clientX: number, clientY: number): DropHit | null {
  const sorted = [...dropZones].sort((a, b) => b.priority - a.priority);
  for (const zone of sorted) {
    const hit = zone.hitTest(clientX, clientY);
    if (hit != null) return hit;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Drag-hover feedback for native drags (Finder drag-in / native self-drops)
// ---------------------------------------------------------------------------

/** The current drag hover: the hit under the cursor plus its client point. */
export interface DropHover {
  hit: DropHit;
  x: number;
  y: number;
}

type DropHoverListener = (h: DropHover | null) => void;
const dropHoverListeners = new Set<DropHoverListener>();

/** Subscribe to drag-hover updates (null = nothing hovered / drag ended).
 *  Consumers filter by `hit.action` / `hit.targetKey`. */
export function onDropHover(fn: DropHoverListener): () => void {
  dropHoverListeners.add(fn);
  return () => dropHoverListeners.delete(fn);
}

/** Broadcast the current hover. Drives the spring-load timer synchronously
 *  before notifying listeners, so ordering is deterministic. */
export function emitDropHover(h: DropHover | null): void {
  updateSpring(h);
  for (const fn of dropHoverListeners) fn(h);
}

/** Subscribe to pin-hover updates (insertion index, null = none). */
export function onPinHover(fn: (index: number | null) => void): () => void {
  return onDropHover((h) => fn(h != null && h.hit.action === "pin" ? h.hit.index : null));
}

// ---------------------------------------------------------------------------
// Spring-loaded folders: hover a dir row/cell for SPRING_LOAD_MS → it opens
// ---------------------------------------------------------------------------

export const SPRING_LOAD_MS = 600;

let springKey: string | null = null;
let springTimer: ReturnType<typeof setTimeout> | null = null;

function cancelSpring(): void {
  if (springTimer != null) clearTimeout(springTimer);
  springTimer = null;
  springKey = null;
}

function updateSpring(h: DropHover | null): void {
  const spring = h?.hit.action === "copyTo" ? h.hit.spring : undefined;
  // Same target: keep the running timer (hover jitter must not reset it).
  if (spring != null && spring.key === springKey) return;
  cancelSpring();
  if (spring == null) return;
  springKey = spring.key;
  springTimer = setTimeout(() => {
    springTimer = null;
    springKey = null;
    spring.open();
  }, SPRING_LOAD_MS);
}

/** Paths of whichever drag is in flight (native session or internal pointer
 *  drag), else null. Zone hit-tests use this to refuse invalid targets. */
export function activeDragPaths(): string[] | null {
  return nativeDragPaths ?? pointerDragPaths;
}

let pointerDragPaths: string[] | null = null;

/** Set by the pointer-drag layer while an internal pointer drag is live. */
export function setPointerDragPaths(paths: string[] | null): void {
  pointerDragPaths = paths;
}

// ---------------------------------------------------------------------------
// Native drag-out session state (tauri-plugin-drag)
// ---------------------------------------------------------------------------
//
// The bridge (lib/ipc/dnd.ts) and the plugin completion callback consult
// this state to tell self-drops (→ internal move, ⌥ copy) from Finder
// drags (→ copy).

let nativeDragPaths: string[] | null = null;
let nativeDropHandled = false;
let altDuringDrag = false;

export function beginNativeDragState(paths: string[], altHeld: boolean): void {
  nativeDragPaths = paths;
  nativeDropHandled = false;
  altDuringDrag = altHeld;
}

/** MUST run on every session end — completion callback AND startDrag
 *  rejection — or a stale flag turns the next Finder drag-in into a move.
 *  Also cancels any armed spring: an Esc-cancelled native session can end
 *  without a "leave" event ever reaching the bridge. */
export function endNativeDragState(): void {
  nativeDragPaths = null;
  nativeDropHandled = false;
  altDuringDrag = false;
  cancelSpring();
}

export function nativeDragPathsNow(): string[] | null {
  return nativeDragPaths;
}

/** Atomically claim the drop for dispatch. The bridge event and the plugin
 *  completion-callback fallback race in unspecified order, and BOTH await a
 *  modifier query before dispatching — each must claim synchronously (before
 *  its first await) and dispatch only if the claim succeeded, or the same
 *  drop runs twice. */
export function tryClaimNativeDrop(): boolean {
  if (nativeDropHandled) return false;
  nativeDropHandled = true;
  return true;
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

/** Apply a native self-drop at a hit zone: pin zones pin, trash rows trash,
 *  folders get an internal move (⌥ held = copy). Same guards as HTML5 drops. */
export function dispatchNativeSelfDrop(hit: DropHit, paths: string[], altCopy: boolean): void {
  if (paths.length === 0) return;
  if (hit.action === "pin") {
    void pinFolders(paths, hit.index);
    return;
  }
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
