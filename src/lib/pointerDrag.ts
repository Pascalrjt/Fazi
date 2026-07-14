/**
 * Pointer-event internal drag — the kill-switch path (Settings → Advanced →
 * native drag-out OFF). HTML5 drops never reach the DOM in the running app
 * (wry swallows NSDraggingDestination callbacks), so internal drags reuse the
 * same DropZone registry + hover channel as native sessions: pointermove
 * hit-tests and feeds rings/highlights/spring, pointerup dispatches, Escape
 * cancels. Pointer events carry live modifiers, so ⌥-at-drop-time is free.
 */
import {
  dispatchNativeSelfDrop,
  emitDropHover,
  hitTestDropZones,
  setPointerDragPaths,
} from "./dnd";

/** Start an internal pointer drag for `paths`. Call from a row's dragstart
 *  (browser drag-threshold detection for free) after `preventDefault()`. */
export function startPointerDrag(paths: string[]): void {
  if (paths.length === 0) return;
  setPointerDragPaths(paths);

  // Cursor-following count badge (the only drag image a pointer drag gets).
  const badge = document.createElement("div");
  badge.textContent = paths.length > 1 ? String(paths.length) : "";
  badge.className = "pointer-drag-badge";
  badge.style.cssText =
    "position:fixed;z-index:9999;pointer-events:none;padding:2px 8px;" +
    "border-radius:10px;background:var(--accent);color:white;" +
    "font:600 12px -apple-system;" +
    (paths.length > 1 ? "" : "width:10px;height:10px;padding:0;");
  badge.style.visibility = "hidden"; // until the first move
  document.body.appendChild(badge);

  const teardown = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("keydown", onKey, true);
    badge.remove();
    emitDropHover(null); // clears rings/highlights and cancels the spring
    setPointerDragPaths(null);
  };

  const onMove = (ev: PointerEvent) => {
    badge.style.visibility = "visible";
    badge.style.left = `${ev.clientX + 12}px`;
    badge.style.top = `${ev.clientY + 12}px`;
    const hit = hitTestDropZones(ev.clientX, ev.clientY);
    emitDropHover(hit ? { hit, x: ev.clientX, y: ev.clientY } : null);
  };

  const onUp = (ev: PointerEvent) => {
    const hit = hitTestDropZones(ev.clientX, ev.clientY);
    teardown();
    if (hit) dispatchNativeSelfDrop(hit, paths, ev.altKey);
  };

  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape") return;
    ev.stopPropagation();
    teardown();
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("keydown", onKey, true);
}
