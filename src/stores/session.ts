/**
 * Tab session: saves each pane's tabs (path, sort, hidden-files toggle,
 * back/forward history), which tab is active, dual pane, and the focused
 * pane to localStorage, and restores them at launch (Settings → General →
 * Reopen tabs at launch).
 *
 * Restore checks every saved folder first. A folder that's gone (deleted,
 * renamed, or on an unplugged drive) reopens at its nearest surviving
 * ancestor rather than as an error tab. Listings, selections, filters, and
 * searches are not part of the session.
 */
import { usePanes, type HistorySnapshot, type RestoredPane } from "./panes";
import { useApp, type PaneId } from "./app";
import { useSettings } from "./settings";
import * as ipc from "../lib/ipc";
import { safeIpc } from "../lib/safeIpc";
import type { SortDir, SortKey } from "../lib/sort";
import { dirname } from "../lib/format";

const STORAGE_KEY = "fazi-session";
/** Back/forward entries kept per tab and direction. */
const HISTORY_CAP = 25;
/** Owner id for the restore-time stat calls (released right after). */
const STAT_OWNER = "session-restore";

export interface SessionTab {
  path: string;
  sort: { key: SortKey; dir: SortDir };
  showHidden: boolean;
  back: string[];
  forward: string[];
}

export interface SessionPane {
  id: PaneId;
  activeIndex: number;
  tabs: SessionTab[];
}

export interface Session {
  version: 1;
  split: boolean;
  activePane: PaneId;
  panes: SessionPane[];
}

const SORT_KEYS: readonly SortKey[] = ["name", "size", "mtime", "kind"];

/** The current layout as a session (no listings, selections, or filters). */
export function captureSession(): Session {
  const { panes, split } = usePanes.getState();
  return {
    version: 1,
    split,
    activePane: useApp.getState().activePaneId,
    panes: panes.map((pane) => ({
      id: pane.id,
      activeIndex: Math.max(
        0,
        pane.tabs.findIndex((t) => t.id === pane.activeTabId),
      ),
      tabs: pane.tabs.map((tab) => ({
        path: tab.path,
        sort: { key: tab.sort.key, dir: tab.sort.dir },
        showHidden: tab.showHidden,
        back: tab.back.slice(-HISTORY_CAP).map((h) => h.path),
        forward: tab.forward.slice(-HISTORY_CAP).map((h) => h.path),
      })),
    })),
  };
}

const isPath = (v: unknown): v is string => typeof v === "string" && v.startsWith("/");

function parseTab(raw: unknown): SessionTab | null {
  if (typeof raw !== "object" || raw == null) return null;
  const t = raw as Record<string, unknown>;
  if (!isPath(t.path)) return null;
  const sort = (t.sort ?? {}) as Record<string, unknown>;
  const key = SORT_KEYS.includes(sort.key as SortKey) ? (sort.key as SortKey) : null;
  const dir = sort.dir === "asc" || sort.dir === "desc" ? sort.dir : null;
  const defaults = useSettings.getState();
  return {
    path: t.path,
    sort: { key: key ?? defaults.defaultSortKey, dir: dir ?? defaults.defaultSortDir },
    showHidden: typeof t.showHidden === "boolean" ? t.showHidden : defaults.showHidden,
    back: Array.isArray(t.back) ? t.back.filter(isPath).slice(-HISTORY_CAP) : [],
    forward: Array.isArray(t.forward) ? t.forward.filter(isPath).slice(-HISTORY_CAP) : [],
  };
}

/** Validate a stored session; anything malformed is dropped, never thrown. */
export function parseSession(json: string | null): Session | null {
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw == null) return null;
  const s = raw as Record<string, unknown>;
  if (s.version !== 1 || !Array.isArray(s.panes)) return null;
  const panes: SessionPane[] = [];
  for (const p of s.panes as unknown[]) {
    if (typeof p !== "object" || p == null) continue;
    const pane = p as Record<string, unknown>;
    if (pane.id !== "left" && pane.id !== "right") continue;
    if (panes.some((existing) => existing.id === pane.id)) continue;
    const tabs = Array.isArray(pane.tabs)
      ? (pane.tabs as unknown[]).map(parseTab).filter((t): t is SessionTab => t != null)
      : [];
    if (tabs.length === 0) continue;
    const idx = typeof pane.activeIndex === "number" ? Math.floor(pane.activeIndex) : 0;
    panes.push({ id: pane.id, tabs, activeIndex: Math.min(Math.max(idx, 0), tabs.length - 1) });
  }
  const left = panes.find((p) => p.id === "left");
  if (!left) return null;
  const right = panes.find((p) => p.id === "right");
  const split = s.split === true && right != null;
  return {
    version: 1,
    split,
    activePane: split && s.activePane === "right" ? "right" : "left",
    panes: split && right ? [left, right] : [left],
  };
}

export function loadSession(): Session | null {
  try {
    return parseSession(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

/**
 * Map each saved path to itself if it still exists, else to its nearest
 * surviving ancestor. `exists` is injectable for tests.
 */
export async function resolvePaths(
  paths: string[],
  exists: (paths: string[]) => Promise<boolean[]>,
): Promise<Map<string, string>> {
  const unique = [...new Set(paths)];
  const resolved = new Map<string, string>();
  let pending = unique;
  // Walk every missing path up one level per round; all lookups in a
  // round go out as one batch.
  const current = new Map(unique.map((p) => [p, p]));
  while (pending.length > 0) {
    const candidates = pending.map((p) => current.get(p) as string);
    const found = await exists(candidates);
    const next: string[] = [];
    pending.forEach((orig, i) => {
      const cand = candidates[i];
      if (found[i] || cand === "/") {
        resolved.set(orig, cand);
      } else {
        current.set(orig, dirname(cand) ?? "/");
        next.push(orig);
      }
    });
    pending = next;
  }
  return resolved;
}

/** Batch existence check through the backend; "/" always exists. */
function backendExists(paths: string[]): Promise<boolean[]> {
  return safeIpc(() => ipc.statPaths(STAT_OWNER, paths))
    .then((entries) => paths.map((p, i) => p === "/" || entries[i] != null))
    .catch(() => paths.map(() => true)) // can't check: open as saved, the listing reports errors
    .finally(() => {
      void safeIpc(() => ipc.cancelListing(STAT_OWNER)).catch(() => {});
    });
}

function toHistory(path: string): HistorySnapshot {
  return { path, scrollTop: 0, selectedNames: [], leadName: null };
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let lastSaved = "";
let stopAutosave: (() => void) | null = null;

function saveNow(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  const json = JSON.stringify(captureSession());
  if (json === lastSaved) return;
  lastSaved = json;
  try {
    localStorage.setItem(STORAGE_KEY, json);
  } catch {
    // storage full or unavailable: the session just won't survive a relaunch
  }
}

/**
 * Save on every layout change (debounced; listings stream many updates).
 * Started only after restore, so the launch placeholder never overwrites
 * the saved session.
 */
export function startSessionAutosave(): () => void {
  stopAutosave?.();
  const schedule = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 400);
  };
  const unsubPanes = usePanes.subscribe((s, prev) => {
    if (s.panes !== prev.panes || s.split !== prev.split) schedule();
  });
  const unsubApp = useApp.subscribe((s, prev) => {
    if (s.activePaneId !== prev.activePaneId) schedule();
  });
  // Quitting can beat the debounce; flush on the way out.
  window.addEventListener("pagehide", saveNow);
  window.addEventListener("beforeunload", saveNow);
  saveNow();
  stopAutosave = () => {
    unsubPanes();
    unsubApp();
    window.removeEventListener("pagehide", saveNow);
    window.removeEventListener("beforeunload", saveNow);
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    stopAutosave = null;
  };
  return stopAutosave;
}

/**
 * Launch: reopen the saved tabs when the setting is on and a session
 * exists, else open one tab at Home. Then start saving.
 */
export async function restoreOrBoot(
  homePath: string,
  exists: (paths: string[]) => Promise<boolean[]> = backendExists,
): Promise<void> {
  const session = useSettings.getState().restoreTabs ? loadSession() : null;
  if (!session) {
    usePanes.getState().boot(homePath);
    startSessionAutosave();
    return;
  }
  // Only the open folders are checked; a stale back/forward entry shows
  // the usual "can't be found" error if you go back to it.
  const tabPaths = session.panes.flatMap((p) => p.tabs.map((t) => t.path));
  const resolved = await resolvePaths(tabPaths, exists);
  const panes: RestoredPane[] = session.panes.map((p) => ({
    id: p.id,
    activeIndex: p.activeIndex,
    tabs: p.tabs.map((t) => ({
      path: resolved.get(t.path) ?? t.path,
      sort: t.sort,
      showHidden: t.showHidden,
      back: t.back.map(toHistory),
      forward: t.forward.map(toHistory),
    })),
  }));
  usePanes.getState().restore(panes, session.split);
  useApp.getState().setActivePane(session.activePane);
  startSessionAutosave();
}
