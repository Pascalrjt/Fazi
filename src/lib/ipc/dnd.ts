/**
 * Finder drag-IN bridge. The only @tauri-apps import besides lib/ipc/index.ts
 * (permitted exception): webview drag-drop events deliver real file paths.
 */
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { hitTestDropZones } from "../dnd";
import { useOps } from "../../stores/ops";

/**
 * Start listening for files dragged in from Finder (or any other app).
 * Drop position is hit-tested against registered drop zones (folder rows,
 * pane backgrounds); files are COPIED to the resolved directory.
 * Returns an unlisten function. Safe without a backend (resolves to no-op).
 */
export async function setupFinderDragIn(): Promise<() => void> {
  try {
    const webview = getCurrentWebview();
    return await webview.onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      const { paths, position } = event.payload;
      if (paths.length === 0) return;
      const scale = window.devicePixelRatio || 1;
      const clientX = position.x / scale;
      const clientY = position.y / scale;
      const destDir = hitTestDropZones(clientX, clientY);
      if (!destDir) return;
      // don't copy something onto itself
      const filtered = paths.filter((p) => {
        const parent = p.slice(0, p.lastIndexOf("/")) || "/";
        return parent !== destDir;
      });
      if (filtered.length === 0) return;
      useOps.getState().startOp({
        kind: "copy",
        sources: filtered,
        destDir,
        policy: "ask",
      });
    });
  } catch {
    return () => {};
  }
}
