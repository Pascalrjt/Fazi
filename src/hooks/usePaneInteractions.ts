/**
 * Entry-row interaction logic shared by the list and grid views: press
 * selection (click/⌘/⇧), double-click open, context menu, rename hand-off,
 * and the drag-gesture dispatch. Both views must behave identically — this
 * is the single implementation.
 */
import { useCallback } from "react";
import type { Entry } from "../types/ipc";
import { findTab, usePanes, visibleEntries } from "../stores/panes";
import { useApp, type PaneId } from "../stores/app";
import { showMenu } from "../stores/menu";
import { entryMenuItems } from "../components/menus/entryMenu";
import { clickSelect, cmdToggle, shiftRange } from "../lib/selection";
import { finishRename } from "../lib/actions";
import { startNativeDrag } from "../lib/ipc/dnd";
import { startPointerDrag } from "../lib/pointerDrag";
import { useSettings } from "../stores/settings";

/**
 * Start the drag for an entry row/cell. dragstart is only the gesture
 * trigger: the caller preventDefault()s and this runs the real drag loop
 * (HTML5 drops are dead under wry). Dragging a selected entry drags the
 * whole selection; an unselected one drags alone.
 */
export function beginEntryDrag(
  paneId: PaneId,
  tabId: string,
  entry: Entry,
  altKey: boolean,
): void {
  const tab = findTab(usePanes.getState(), paneId, tabId);
  if (!tab) return;
  const paths = tab.selection.selected.has(entry.id)
    ? tab.entries.filter((en) => tab.selection.selected.has(en.id)).map((en) => en.path)
    : [entry.path];
  if (useSettings.getState().dragOutEnabled) {
    // Native drag: reaches Finder/Mail/…; self-drops come back through
    // the bridge as internal moves.
    startNativeDrag(paths, altKey);
    return;
  }
  // Kill-switch: internal-only pointer drag through the same registry.
  startPointerDrag(paths);
}

export function usePaneInteractions(paneId: PaneId, tabId: string) {
  const setSelection = usePanes((s) => s.setSelection);
  const openEntry = usePanes((s) => s.openEntry);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent, entry: Entry) => {
      if (e.button === 2) return; // context menu handles its own selection
      useApp.getState().setActivePane(paneId);
      const t = findTab(usePanes.getState(), paneId, tabId);
      if (!t) return;
      const order = visibleEntries(t).map((en) => en.id);
      const sel = t.selection;
      if (e.shiftKey) {
        setSelection(paneId, tabId, shiftRange(sel, order, entry.id));
      } else if (e.metaKey) {
        setSelection(paneId, tabId, cmdToggle(sel, entry.id));
      } else if (!sel.selected.has(entry.id)) {
        setSelection(paneId, tabId, clickSelect(entry.id));
      }
      // clicking an already-selected row keeps the multi-selection (drag support)
    },
    [paneId, tabId, setSelection],
  );

  const handleDoubleClick = useCallback(
    (entry: Entry) => openEntry(paneId, tabId, entry),
    [openEntry, paneId, tabId],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, entry: Entry) => {
      e.preventDefault();
      e.stopPropagation();
      useApp.getState().setActivePane(paneId);
      const t = findTab(usePanes.getState(), paneId, tabId);
      if (!t) return;
      if (!t.selection.selected.has(entry.id)) {
        setSelection(paneId, tabId, clickSelect(entry.id));
      }
      showMenu(e.clientX, e.clientY, entryMenuItems(paneId, tabId, entry));
    },
    [paneId, tabId, setSelection],
  );

  const handleRenameDone = useCallback(
    (entry: Entry, advance: boolean) => {
      finishRename(paneId, tabId, entry.id, advance);
    },
    [paneId, tabId],
  );

  return { handleMouseDown, handleDoubleClick, handleContextMenu, handleRenameDone };
}
