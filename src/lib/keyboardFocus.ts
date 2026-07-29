/** Narrow DOM bridge for moving keyboard ownership between browse surfaces. */
import { activePaneTab } from "../stores/panes";
import { useApp, type PaneId } from "../stores/app";
import { showMenu } from "../stores/menu";
import { entryMenuItems } from "../components/menus/entryMenu";

const SIDEBAR_ROW = "[data-sidebar-row]";
const ENTRY_TARGET = "[data-entry-id][data-pane-id]";
const BROWSE_SURFACE = '[data-vim-surface="sidebar"], [data-vim-surface="pane"]';

function focusElement(el: HTMLElement | null): boolean {
  if (!el) return false;
  el.focus({ preventScroll: true });
  return true;
}

function paneIdOf(el: HTMLElement): PaneId | null {
  return el.dataset.paneId === "left" || el.dataset.paneId === "right"
    ? el.dataset.paneId
    : null;
}

function focusPane(el: HTMLElement): boolean {
  const paneId = paneIdOf(el);
  if (!paneId) return false;
  useApp.getState().setActivePane(paneId);
  return focusElement(el);
}

function activePaneElement(): HTMLElement | null {
  const paneId = activePaneTab()?.pane.id;
  if (!paneId) return null;
  const panes = document.querySelectorAll<HTMLElement>('[data-vim-surface="pane"]');
  return [...panes].find((el) => el.dataset.paneId === paneId) ?? null;
}

/**
 * Remember the browse owner before a menu, input, or modal takes focus.
 * Falls back to the active pane when focus is currently on window chrome.
 */
export function captureBrowseFocus(): HTMLElement | null {
  const active = document.activeElement;
  if (active instanceof HTMLElement) {
    const row = active.closest<HTMLElement>(SIDEBAR_ROW);
    if (row) return row;
    const surface = active.closest<HTMLElement>(BROWSE_SURFACE);
    if (surface) return surface;
  }
  return activePaneElement();
}

/** Restore a remembered browse owner, with the active pane as a safe fallback. */
export function restoreBrowseFocus(target: HTMLElement | null): boolean {
  if (target?.isConnected) {
    const row = target.closest<HTMLElement>(SIDEBAR_ROW);
    if (row) return focusElement(row);
    const surface = target.closest<HTMLElement>(BROWSE_SURFACE);
    if (surface?.dataset.vimSurface === "pane") return focusPane(surface);
  }
  return focusActivePane();
}

/** Focus the sidebar's current location, falling back to its roving tab stop. */
export function focusSidebar(): boolean {
  const current = document.querySelector<HTMLElement>(`${SIDEBAR_ROW}[aria-current="page"]`);
  const tabStop = document.querySelector<HTMLElement>(`${SIDEBAR_ROW}[tabindex="0"]`);
  const first = document.querySelector<HTMLElement>(SIDEBAR_ROW);
  return focusElement(current ?? tabStop ?? first);
}

/** Return keyboard ownership to the active file pane. */
export function focusActivePane(): boolean {
  const pane = activePaneElement();
  return pane ? focusPane(pane) : false;
}

/** Cycle through visible browse surfaces in their on-screen DOM order. */
export function cycleBrowseSurface(): boolean {
  const surfaces = [
    ...document.querySelectorAll<HTMLElement>(
      '[data-vim-surface="sidebar"], [data-vim-surface="pane"]',
    ),
  ];
  if (surfaces.length === 0) return false;

  const focused =
    document.activeElement instanceof HTMLElement
      ? document.activeElement.closest<HTMLElement>("[data-vim-surface]")
      : null;
  let index = focused ? surfaces.indexOf(focused) : -1;
  if (index < 0) {
    const activePaneId = useApp.getState().activePaneId;
    index = surfaces.findIndex(
      (surface) =>
        surface.dataset.vimSurface === "pane" && surface.dataset.paneId === activePaneId,
    );
  }

  const next = surfaces[(index + 1 + surfaces.length) % surfaces.length];
  return next.dataset.vimSurface === "sidebar" ? focusSidebar() : focusPane(next);
}

function activeEntryContext() {
  const at = activePaneTab();
  const lead = at?.tab.selection.lead ?? at?.tab.selection.selected.values().next().value;
  if (!at || lead == null) return null;
  const entry = at.tab.entries.find((candidate) => candidate.id === lead);
  return entry ? { ...at, entry } : null;
}

function selectedEntryTarget(): HTMLElement | null {
  const context = activeEntryContext();
  if (!context) return null;
  const targets = document.querySelectorAll<HTMLElement>(ENTRY_TARGET);
  return (
    [...targets].find(
      (el) =>
        el.dataset.paneId === context.pane.id &&
        Number(el.dataset.entryId) === context.entry.id,
    ) ?? null
  );
}

/** Whether the focused sidebar row or active pane selection has a menu target. */
export function hasKeyboardContextMenuTarget(): boolean {
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && focused.closest(SIDEBAR_ROW)) return true;
  return activeEntryContext() !== null;
}

/** Dispatch the same contextmenu event as a secondary click, anchored to the row. */
export function openKeyboardContextMenu(): boolean {
  const focused = document.activeElement;
  const sidebarTarget =
    focused instanceof HTMLElement ? focused.closest<HTMLElement>(SIDEBAR_ROW) : null;
  const target = sidebarTarget ?? selectedEntryTarget();
  if (!target) {
    const context = activeEntryContext();
    if (!context) return false;
    showMenu(
      window.innerWidth / 2 - 116,
      window.innerHeight / 3,
      entryMenuItems(context.pane.id, context.tab.id, context.entry),
    );
    return true;
  }
  const rect = target.getBoundingClientRect();
  target.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + Math.min(28, Math.max(1, rect.width / 2)),
      clientY: rect.top + Math.max(1, rect.height / 2),
    }),
  );
  return true;
}
