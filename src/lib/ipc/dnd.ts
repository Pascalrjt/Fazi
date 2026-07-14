/**
 * Native drag bridge — the only @tauri-apps importers besides lib/ipc/index.ts
 * (permitted exceptions): webview drag-drop events deliver real file paths,
 * and tauri-plugin-drag starts native drag-OUT sessions.
 *
 * Drag-in (Finder → Fazi): drops are hit-tested against the DropZone
 * registry; files are copied (or trashed for the Trash zone, or pinned to
 * Favorites for pin zones). Enter/over events feed pin-hover feedback.
 *
 * Drag-out (Fazi → anywhere): rows start a native session via startDrag.
 * A session dropped back on our own window (self-drop) becomes an internal
 * move (⌥ = copy): the drag-drop event fires for native sessions too, and the
 * native-drag state tells self from external. If the event never fires for a
 * self-drop (spike risk (a)), the plugin's completion callback hit-tests its
 * cursor position as a fallback — `markNativeDropHandled` keeps the two paths
 * from double-dispatching.
 */
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import {
  altHeldDuringDrag,
  beginNativeDragState,
  dispatchNativeSelfDrop,
  dragImageDataUrl,
  emitDropHover,
  endNativeDragState,
  hitTestDropZones,
  markNativeDropHandled,
  nativeDragPathsNow,
  wasNativeDropHandled,
} from "../dnd";
import { useOps } from "../../stores/ops";
import { trashPathsWithUndo } from "../actions";
import { pinFolders } from "../pin";
import { dragModifiers } from "./index";

/** ⌥ state at drop time. The webview gets no key events during an AppKit
 *  drag session, so ask the backend for the live hardware state; fall back
 *  to the dragstart/tracker snapshot when no backend answers. */
async function altAtDropTime(): Promise<boolean> {
  try {
    return (await dragModifiers()).alt;
  } catch {
    return altHeldDuringDrag();
  }
}

/**
 * Start listening for files dropped onto the window — from Finder (or any
 * other app), and for our own native drag-out sessions landing back on us.
 * Returns an unlisten function. Safe without a backend (resolves to no-op).
 */
export async function setupFinderDragIn(): Promise<() => void> {
  try {
    const webview = getCurrentWebview();
    return await webview.onDragDropEvent((event) => {
      const scale = window.devicePixelRatio || 1;
      // "enter" and "over" both carry a position — handle them identically
      // so hover feedback appears the moment the drag enters the window,
      // not on the first subsequent move.
      if (event.payload.type === "enter" || event.payload.type === "over") {
        const { position } = event.payload;
        const x = position.x / scale;
        const y = position.y / scale;
        const hover = hitTestDropZones(x, y);
        emitDropHover(hover ? { hit: hover, x, y } : null);
        return;
      }
      if (event.payload.type === "leave") {
        emitDropHover(null);
        return;
      }
      if (event.payload.type !== "drop") return;
      emitDropHover(null);
      const { paths, position } = event.payload;
      if (paths.length === 0) return;
      const clientX = position.x / scale;
      const clientY = position.y / scale;
      const hit = hitTestDropZones(clientX, clientY);
      if (!hit) return;

      // Self-drop of our own native drag-out → internal move (⌥ = copy).
      const selfPaths = nativeDragPathsNow();
      if (selfPaths != null) {
        // Claim the drop BEFORE any await — this is the double-dispatch
        // guard the 120ms completion-callback fallback checks.
        markNativeDropHandled();
        void altAtDropTime().then((alt) => dispatchNativeSelfDrop(hit, selfPaths, alt));
        return;
      }

      if (hit.action === "pin") {
        // Folders dragged in from Finder pin at the hovered slot.
        void pinFolders(paths, hit.index);
        return;
      }
      if (hit.action === "trash") {
        // Trash drops are a special action, never a copy into ~/.Trash.
        trashPathsWithUndo(paths);
        return;
      }
      // don't copy something onto itself
      const filtered = paths.filter((p) => {
        const parent = p.slice(0, p.lastIndexOf("/")) || "/";
        return parent !== hit.destDir;
      });
      if (filtered.length === 0) return;
      useOps.getState().startOp({
        kind: "copy",
        sources: filtered,
        destDir: hit.destDir,
        policy: "ask",
      });
    });
  } catch {
    return () => {};
  }
}

/** How long the completion callback waits for the bridge to claim the drop
 *  before running its own hit-test (the two arrive in unspecified order). */
const SELF_DROP_FALLBACK_DELAY_MS = 120;

/**
 * Start a native drag-out session for `paths`. The caller must have
 * `preventDefault()`ed the HTML5 drag.
 */
export function startNativeDrag(paths: string[], altHeld: boolean): void {
  if (paths.length === 0) return;
  beginNativeDragState(paths, altHeld);
  const icon = dragImageDataUrl(paths.length);
  startDrag({ item: paths, icon }, (payload) => {
    if (payload.result !== "Dropped") {
      emitDropHover(null); // clear rings/spring from a cancelled session
      endNativeDragState();
      return;
    }
    // Give the bridge first claim, then fall back to the cursor hit-test.
    setTimeout(() => {
      void finishNativeDrop(Number(payload.cursorPos.x), Number(payload.cursorPos.y));
    }, SELF_DROP_FALLBACK_DELAY_MS);
  }).catch(() => {
    // A rejected start must not wedge move semantics for the NEXT drag.
    endNativeDragState();
  });
}

/** Completion-callback fallback: map the screen cursor position into client
 *  coordinates and dispatch if it landed on one of our drop zones. */
async function finishNativeDrop(screenX: number, screenY: number): Promise<void> {
  const paths = nativeDragPathsNow();
  if (paths == null || wasNativeDropHandled()) {
    endNativeDragState();
    return;
  }
  try {
    const win = getCurrentWindow();
    const [inner, scale] = await Promise.all([win.innerPosition(), win.scaleFactor()]);
    // Plugin cursorPos is logical screen coords; innerPosition is physical.
    const clientX = screenX - inner.x / scale;
    const clientY = screenY - inner.y / scale;
    const inWindow =
      clientX >= 0 && clientY >= 0 && clientX <= window.innerWidth && clientY <= window.innerHeight;
    if (inWindow && !wasNativeDropHandled()) {
      const hit = hitTestDropZones(clientX, clientY);
      if (hit) dispatchNativeSelfDrop(hit, paths, await altAtDropTime());
    }
  } catch {
    // No backend / window API unavailable — external drop, nothing to do.
  }
  endNativeDragState();
}
