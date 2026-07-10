/**
 * Panes → tabs → listings. The state model the whole frontend hangs off.
 *
 * Listing lifecycle: navigate → new listingId → cancel old listing/watch →
 * listDir streams chunks (arrival order for large dirs, per-chunk re-sort for
 * small) → "listed" settles the sort once → "done" starts the watcher.
 */
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { enableMapSet } from "immer";
import type { Entry, ListErrorCode, ListEvent, WatchEvent } from "../types/ipc";
import * as ipc from "../lib/ipc";
import { dropHydrator, initHydrator } from "../lib/hydration";
import { useDirSizes } from "./dirSizes";
import { safeIpc } from "../lib/safeIpc";
import { sortEntries, type SortDir, type SortKey, type SortSpec } from "../lib/sort";
import {
  emptySelection,
  pruneSelection,
  type SelectionState,
} from "../lib/selection";
import { basename, dirname, joinPath, pluralize } from "../lib/format";
import { useSettings } from "./settings";
import { useApp, type PaneId } from "./app";

enableMapSet();

/** Above this many entries, pass-1 chunks render in arrival order until "listed". */
const RESORT_THRESHOLD = 10_000;

export interface HistorySnapshot {
  path: string;
  scrollTop: number;
  selectedNames: string[];
  leadName: string | null;
}

interface PendingRestore {
  scrollTop?: number;
  selectNames?: string[];
  leadName?: string;
}

export interface GhostEntry {
  /** Negative synthetic id — never collides with backend ids. */
  id: number;
  name: string;
  path: string;
  isDir: boolean;
}

export interface Tab {
  id: string;
  path: string;
  back: HistorySnapshot[];
  forward: HistorySnapshot[];
  listingId: string;
  watchId: string | null;
  entries: Entry[];
  /** Total from the "listed" event; null while pass 1 streams. */
  total: number | null;
  listed: boolean;
  loading: boolean;
  /** Large dir waiting for the settle sort. */
  sorting: boolean;
  error: { code: ListErrorCode | "unknown"; message: string } | null;
  sort: SortSpec;
  filter: string;
  showHidden: boolean;
  selection: SelectionState;
  scrollTop: number;
  pendingRestore: PendingRestore | null;
  ghosts: GhostEntry[];
}

export interface Pane {
  id: PaneId;
  tabs: Tab[];
  activeTabId: string;
}

interface PanesState {
  panes: Pane[];
  split: boolean;

  // --- lookups ---------------------------------------------------------
  // (plain functions on state; components use fine-grained selectors)

  // --- navigation ------------------------------------------------------
  boot(homePath: string): void;
  navigate(paneId: PaneId, tabId: string, path: string, opts?: { selectName?: string }): void;
  refresh(paneId: PaneId, tabId: string): void;
  back(paneId: PaneId, tabId: string): void;
  forward(paneId: PaneId, tabId: string): void;
  up(paneId: PaneId, tabId: string): void;
  openEntry(paneId: PaneId, tabId: string, entry: Entry): void;

  // --- tabs / panes ----------------------------------------------------
  openTab(paneId: PaneId, path: string): void;
  closeTab(paneId: PaneId, tabId: string): void;
  activateTab(paneId: PaneId, tabId: string): void;
  cycleTab(paneId: PaneId, delta: 1 | -1): void;
  setSplit(split: boolean, initialPath?: string): void;

  // --- listing plumbing --------------------------------------------------
  applyListEvent(paneId: PaneId, tabId: string, listingId: string, event: ListEvent): void;
  applyWatchBatch(paneId: PaneId, tabId: string, watchId: string, event: WatchEvent): void;

  // --- view state --------------------------------------------------------
  setSort(paneId: PaneId, tabId: string, key: SortKey, dir?: SortDir): void;
  setFilter(paneId: PaneId, tabId: string, filter: string): void;
  setTabShowHidden(paneId: PaneId, tabId: string, show: boolean): void;
  setScrollTop(paneId: PaneId, tabId: string, px: number): void;

  // --- selection ---------------------------------------------------------
  setSelection(paneId: PaneId, tabId: string, next: SelectionState): void;
  selectByNames(paneId: PaneId, tabId: string, names: string[]): void;

  // --- optimistic updates --------------------------------------------------
  /** Optimistic local rename: patch name/path/ext in place, keep id + selection, re-sort. */
  renameLocal(paneId: PaneId, tabId: string, entryId: number, newName: string, newPath: string): void;
  removeEntriesByPath(paths: string[]): void;
  addGhosts(destDir: string, paths: string[], isDir?: boolean): void;
  upsertEntryNow(paneId: PaneId, tabId: string, entry: Entry): void;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

let ghostSeq = 0;

function newTab(path: string): Tab {
  const settings = useSettings.getState();
  return {
    id: crypto.randomUUID(),
    path,
    back: [],
    forward: [],
    listingId: "",
    watchId: null,
    entries: [],
    total: null,
    listed: false,
    loading: true,
    sorting: false,
    error: null,
    sort: { key: settings.defaultSortKey, dir: settings.defaultSortDir },
    filter: "",
    showHidden: settings.showHidden,
    selection: emptySelection(),
    scrollTop: 0,
    pendingRestore: null,
    ghosts: [],
  };
}

function findPane(s: { panes: Pane[] }, paneId: PaneId): Pane | undefined {
  return s.panes.find((p) => p.id === paneId);
}

function findTab(s: { panes: Pane[] }, paneId: PaneId, tabId: string): Tab | undefined {
  return findPane(s, paneId)?.tabs.find((t) => t.id === tabId);
}

export function activeTabOf(pane: Pane): Tab {
  return pane.tabs.find((t) => t.id === pane.activeTabId) ?? pane.tabs[0];
}

function snapshot(tab: Tab): HistorySnapshot {
  const nameOf = new Map(tab.entries.map((e) => [e.id, e.name]));
  return {
    path: tab.path,
    scrollTop: tab.scrollTop,
    selectedNames: [...tab.selection.selected]
      .map((id) => nameOf.get(id))
      .filter((n): n is string => n != null),
    leadName: tab.selection.lead != null ? (nameOf.get(tab.selection.lead) ?? null) : null,
  };
}

function applyRestore(tab: Tab): void {
  const restore = tab.pendingRestore;
  if (!restore) return;
  if (restore.selectNames && restore.selectNames.length > 0) {
    const wanted = new Set(restore.selectNames);
    const selected = new Set<number>();
    let lead: number | null = null;
    for (const e of tab.entries) {
      if (wanted.has(e.name)) {
        selected.add(e.id);
        if (restore.leadName === e.name || lead === null) lead = e.id;
      }
    }
    if (selected.size > 0) {
      tab.selection = { selected, anchor: lead, lead };
    }
  }
  if (restore.scrollTop != null) tab.scrollTop = restore.scrollTop;
  tab.pendingRestore = null;
}

/** Start a fresh listing for a tab (mutates the draft), then kicks off IPC. */
function startListing(
  set: (fn: (s: PanesState) => void) => void,
  get: () => PanesState,
  paneId: PaneId,
  tabId: string,
): void {
  const tab = findTab(get(), paneId, tabId);
  if (!tab) return;
  const listingId = tab.listingId;
  const path = tab.path;
  safeIpc(() =>
    ipc.listDir(path, listingId, (event) => {
      get().applyListEvent(paneId, tabId, listingId, event);
    }),
  )
    .catch((err) => {
      set((s) => {
        const t = findTab(s, paneId, tabId);
        if (!t || t.listingId !== listingId) return;
        t.loading = false;
        t.error = { code: "unknown", message: String(err) };
      });
    });
}

function stopListing(tab: Tab): void {
  if (tab.listingId) {
    void ipc.cancelListing(tab.listingId).catch(() => {});
    dropHydrator(tab.listingId);
  }
  if (tab.watchId) {
    void ipc.unwatch(tab.watchId).catch(() => {});
  }
}

function resetForNavigation(tab: Tab, path: string): void {
  tab.path = path;
  tab.listingId = crypto.randomUUID();
  tab.watchId = null;
  tab.entries = [];
  tab.total = null;
  tab.listed = false;
  tab.loading = true;
  tab.sorting = false;
  tab.error = null;
  tab.filter = "";
  tab.selection = emptySelection();
  tab.scrollTop = 0;
  tab.ghosts = [];
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

export const usePanes = create<PanesState>()(
  immer((set, get) => ({
    panes: [{ id: "left", tabs: [newTab("/")], activeTabId: "" }],
    split: false,

    boot: (homePath) => {
      set((s) => {
        const tab = newTab(homePath);
        s.panes = [{ id: "left", tabs: [tab], activeTabId: tab.id }];
        s.split = false;
      });
      const pane = get().panes[0];
      startListing(set, get, "left", pane.activeTabId);
    },

    navigate: (paneId, tabId, path, opts) => {
      set((s) => {
        const tab = findTab(s, paneId, tabId);
        if (!tab) return;
        stopListing(tab);
        if (tab.path !== path || tab.error) {
          tab.back.push(snapshot(tab));
          if (tab.back.length > 100) tab.back.shift();
          tab.forward = [];
        }
        resetForNavigation(tab, path);
        tab.pendingRestore = opts?.selectName
          ? { selectNames: [opts.selectName], leadName: opts.selectName }
          : null;
      });
      // navigating away closes rename + global search for that pane
      const app = useApp.getState();
      if (app.renaming && app.renaming.paneId === paneId && app.renaming.tabId === tabId) {
        app.stopRename();
      }
      startListing(set, get, paneId, tabId);
    },

    refresh: (paneId, tabId) => {
      set((s) => {
        const tab = findTab(s, paneId, tabId);
        if (!tab) return;
        stopListing(tab);
        const keep: PendingRestore = {
          scrollTop: tab.scrollTop,
          selectNames: snapshot(tab).selectedNames,
          leadName: snapshot(tab).leadName ?? undefined,
        };
        resetForNavigation(tab, tab.path);
        tab.pendingRestore = keep;
      });
      startListing(set, get, paneId, tabId);
    },

    back: (paneId, tabId) => {
      let target: HistorySnapshot | undefined;
      set((s) => {
        const tab = findTab(s, paneId, tabId);
        if (!tab || tab.back.length === 0) return;
        target = tab.back.pop();
        tab.forward.push(snapshot(tab));
        if (!target) return;
        stopListing(tab);
        resetForNavigation(tab, target.path);
        tab.pendingRestore = {
          scrollTop: target.scrollTop,
          selectNames: target.selectedNames,
          leadName: target.leadName ?? undefined,
        };
      });
      if (target) startListing(set, get, paneId, tabId);
    },

    forward: (paneId, tabId) => {
      let target: HistorySnapshot | undefined;
      set((s) => {
        const tab = findTab(s, paneId, tabId);
        if (!tab || tab.forward.length === 0) return;
        target = tab.forward.pop();
        tab.back.push(snapshot(tab));
        if (!target) return;
        stopListing(tab);
        resetForNavigation(tab, target.path);
        tab.pendingRestore = {
          scrollTop: target.scrollTop,
          selectNames: target.selectedNames,
          leadName: target.leadName ?? undefined,
        };
      });
      if (target) startListing(set, get, paneId, tabId);
    },

    up: (paneId, tabId) => {
      const tab = findTab(get(), paneId, tabId);
      if (!tab) return;
      const parent = dirname(tab.path);
      if (parent == null) return;
      const cameFrom = basename(tab.path);
      get().navigate(paneId, tabId, parent, { selectName: cameFrom });
    },

    openEntry: (paneId, tabId, entry) => {
      if (entry.kind === "dir" && !entry.isPackage) {
        get().navigate(paneId, tabId, entry.path);
        return;
      }
      if (entry.kind === "symlink" && entry.linkTarget) {
        // resolve dir symlinks by navigating; files open normally
        void ipc.openPaths([entry.path]).catch((err) => {
          useApp.getState().pushToast(`Couldn't open “${entry.name}”: ${err}`, { danger: true });
        });
        return;
      }
      void ipc.openPaths([entry.path]).catch((err) => {
        useApp.getState().pushToast(`Couldn't open “${entry.name}”: ${err}`, { danger: true });
      });
    },

    openTab: (paneId, path) => {
      let tabId = "";
      set((s) => {
        const pane = findPane(s, paneId);
        if (!pane) return;
        const tab = newTab(path);
        tabId = tab.id;
        pane.tabs.push(tab);
        pane.activeTabId = tab.id;
      });
      if (tabId) startListing(set, get, paneId, tabId);
    },

    closeTab: (paneId, tabId) => {
      const state = get();
      const pane = findPane(state, paneId);
      if (!pane) return;
      if (pane.tabs.length === 1) {
        // closing the last tab: close the pane if split, else no-op
        if (state.split) {
          const tab = pane.tabs[0];
          stopListing(tab);
          set((s) => {
            s.panes = s.panes.filter((p) => p.id !== paneId);
            s.split = false;
            // the surviving pane always becomes "left" (PaneArea renders it)
            if (s.panes.length === 1) s.panes[0].id = "left";
          });
          useApp.getState().setActivePane("left");
        }
        return;
      }
      set((s) => {
        const p = findPane(s, paneId);
        if (!p) return;
        const idx = p.tabs.findIndex((t) => t.id === tabId);
        if (idx === -1) return;
        stopListing(p.tabs[idx]);
        p.tabs.splice(idx, 1);
        if (p.activeTabId === tabId) {
          p.activeTabId = p.tabs[Math.min(idx, p.tabs.length - 1)].id;
        }
      });
    },

    activateTab: (paneId, tabId) => {
      set((s) => {
        const pane = findPane(s, paneId);
        if (pane && pane.tabs.some((t) => t.id === tabId)) pane.activeTabId = tabId;
      });
    },

    cycleTab: (paneId, delta) => {
      set((s) => {
        const pane = findPane(s, paneId);
        if (!pane || pane.tabs.length < 2) return;
        const idx = pane.tabs.findIndex((t) => t.id === pane.activeTabId);
        const next = (idx + delta + pane.tabs.length) % pane.tabs.length;
        pane.activeTabId = pane.tabs[next].id;
      });
    },

    setSplit: (split, initialPath) => {
      const state = get();
      if (split === state.split) return;
      if (split) {
        let tabId = "";
        set((s) => {
          const leftActive = activeTabOf(s.panes[0]);
          const tab = newTab(initialPath ?? leftActive.path);
          tabId = tab.id;
          s.panes.push({ id: "right", tabs: [tab], activeTabId: tab.id });
          s.split = true;
        });
        startListing(set, get, "right", tabId);
        useApp.getState().setActivePane("right");
      } else {
        const right = findPane(state, "right");
        if (right) for (const t of right.tabs) stopListing(t);
        set((s) => {
          s.panes = s.panes.filter((p) => p.id !== "right");
          s.split = false;
        });
        useApp.getState().setActivePane("left");
      }
    },

    applyListEvent: (paneId, tabId, listingId, event) => {
      set((s) => {
        const tab = findTab(s, paneId, tabId);
        if (!tab || tab.listingId !== listingId) return; // stale listing
        switch (event.event) {
          case "chunk": {
            tab.loading = false;
            tab.entries.push(...event.entries);
            if (!tab.listed) {
              if (tab.entries.length <= RESORT_THRESHOLD) {
                tab.entries = sortEntries(tab.entries, tab.sort);
              } else {
                tab.sorting = true; // arrival order; settle at "listed"
              }
            }
            break;
          }
          case "listed": {
            tab.total = event.total;
            tab.listed = true;
            tab.loading = false;
            tab.entries = sortEntries(tab.entries, tab.sort);
            tab.sorting = false;
            applyRestore(tab);
            break;
          }
          case "hydrate": {
            const byId = new Map(event.entries.map((e) => [e.id, e]));
            for (let i = 0; i < tab.entries.length; i++) {
              const patch = byId.get(tab.entries[i].id);
              if (patch) tab.entries[i] = patch;
            }
            // ghost cleanup: hydrated real entries replace ghosts by name
            if (tab.ghosts.length > 0) {
              const names = new Set(event.entries.map((e) => e.name));
              tab.ghosts = tab.ghosts.filter((g) => !names.has(g.name));
            }
            if (tab.listed && tab.sort.key !== "name") {
              tab.entries = sortEntries(tab.entries, tab.sort);
            }
            break;
          }
          case "done": {
            tab.loading = false;
            if (!tab.listed) {
              tab.listed = true;
              tab.total = tab.entries.length;
              tab.entries = sortEntries(tab.entries, tab.sort);
              tab.sorting = false;
              applyRestore(tab);
            }
            break;
          }
          case "error": {
            tab.loading = false;
            tab.error = { code: event.code, message: event.message };
            break;
          }
          default: {
            const _exhaustive: never = event;
            void _exhaustive;
          }
        }
      });

      // side effects outside the draft
      if (event.event === "done") {
        const tab = findTab(get(), paneId, tabId);
        if (!tab || tab.listingId !== listingId || tab.error) return;
        // Big listing (pass 2 skipped server-side): hand the unhydrated rows
        // to the shared viewport-priority scheduler.
        if (tab.entries.some((e) => !e.hydrated)) {
          initHydrator(paneId, tabId, listingId, tab.entries);
        }
        const watchId = crypto.randomUUID();
        set((s) => {
          const t = findTab(s, paneId, tabId);
          if (t && t.listingId === listingId) t.watchId = watchId;
        });
        safeIpc(() =>
          ipc.watchDir(tab.path, watchId, (we) => {
            get().applyWatchBatch(paneId, tabId, watchId, we);
          }),
        )
          .catch(() => {
            // watcher is best-effort; listing remains valid without it
          });
      }
    },

    applyWatchBatch: (paneId, tabId, watchId, event) => {
      const state = get();
      const tab = findTab(state, paneId, tabId);
      if (!tab || tab.watchId !== watchId) return;

      switch (event.event) {
        case "batch": {
          if (event.rescan) {
            state.refresh(paneId, tabId);
            return;
          }
          if (event.removed.length > 0) {
            set((s) => {
              const t = findTab(s, paneId, tabId);
              if (!t || t.watchId !== watchId) return;
              const gone = new Set(event.removed);
              const before = t.entries.length;
              t.entries = t.entries.filter((e) => !gone.has(e.name));
              t.ghosts = t.ghosts.filter((g) => !gone.has(g.name));
              if (t.entries.length !== before) {
                if (t.total != null) t.total -= before - t.entries.length;
                t.selection = pruneSelection(
                  t.selection,
                  new Set(t.entries.map((e) => e.id)),
                );
              }
            });
          }
          const changed = [...event.upserted, ...event.removed].map((name) =>
            joinPath(tab.path, name),
          );
          if (changed.length > 0) useDirSizes.getState().invalidate(changed);
          if (event.upserted.length > 0) {
            // One bulk stat per batch — hot dirs no longer fan out one IPC
            // call per changed name.
            const paths = event.upserted.map((name) => joinPath(tab.path, name));
            ipc
              .statPaths(tab.listingId, paths)
              .then((entries) => {
                for (const entry of entries) {
                  if (entry) get().upsertEntryNow(paneId, tabId, entry);
                }
              })
              .catch(() => {});
          }
          break;
        }
        case "rootGone": {
          // walk up to the nearest surviving ancestor
          const from = tab.path;
          useApp.getState().pushToast(`“${basename(from)}” is no longer available`);
          const parent = dirname(from) ?? "/";
          state.navigate(paneId, tabId, parent);
          break;
        }
        default: {
          const _exhaustive: never = event;
          void _exhaustive;
        }
      }
    },

    setSort: (paneId, tabId, key, dir) => {
      set((s) => {
        const tab = findTab(s, paneId, tabId);
        if (!tab) return;
        const nextDir: SortDir =
          dir ?? (tab.sort.key === key ? (tab.sort.dir === "asc" ? "desc" : "asc") : "asc");
        tab.sort = { key, dir: nextDir };
        tab.entries = sortEntries(tab.entries, tab.sort);
      });
      const tab = findTab(get(), paneId, tabId);
      if (tab) useSettings.getState().setDefaultSort(tab.sort.key, tab.sort.dir);
    },

    setFilter: (paneId, tabId, filter) => {
      set((s) => {
        const tab = findTab(s, paneId, tabId);
        if (tab) tab.filter = filter;
      });
    },

    setTabShowHidden: (paneId, tabId, show) => {
      set((s) => {
        const tab = findTab(s, paneId, tabId);
        if (tab) tab.showHidden = show;
      });
    },

    setScrollTop: (paneId, tabId, px) => {
      set((s) => {
        const tab = findTab(s, paneId, tabId);
        if (tab) tab.scrollTop = px;
      });
    },

    setSelection: (paneId, tabId, next) => {
      set((s) => {
        const tab = findTab(s, paneId, tabId);
        if (tab) tab.selection = next;
      });
    },

    selectByNames: (paneId, tabId, names) => {
      set((s) => {
        const tab = findTab(s, paneId, tabId);
        if (!tab) return;
        const wanted = new Set(names);
        const selected = new Set<number>();
        let lead: number | null = null;
        for (const e of tab.entries) {
          if (wanted.has(e.name)) {
            selected.add(e.id);
            lead = e.id;
          }
        }
        tab.selection = { selected, anchor: lead, lead };
      });
    },

    renameLocal: (paneId, tabId, entryId, newName, newPath) => {
      set((s) => {
        const tab = findTab(s, paneId, tabId);
        if (!tab) return;
        const idx = tab.entries.findIndex((e) => e.id === entryId);
        if (idx === -1) return;
        const old = tab.entries[idx];
        const dotIdx = newName.lastIndexOf(".");
        const ext = dotIdx > 0 ? newName.slice(dotIdx + 1).toLowerCase() : "";
        tab.entries[idx] = {
          ...old,
          name: newName,
          path: newPath,
          ext,
          hidden: newName.startsWith("."),
        };
        tab.entries = sortEntries(tab.entries, tab.sort);
      });
    },

    removeEntriesByPath: (paths) => {
      const byDir = new Map<string, Set<string>>();
      for (const p of paths) {
        const d = dirname(p) ?? "/";
        let set0 = byDir.get(d);
        if (!set0) {
          set0 = new Set();
          byDir.set(d, set0);
        }
        set0.add(basename(p));
      }
      set((s) => {
        for (const pane of s.panes) {
          for (const tab of pane.tabs) {
            const names = byDir.get(tab.path);
            if (!names) continue;
            const before = tab.entries.length;
            tab.entries = tab.entries.filter((e) => !names.has(e.name));
            tab.ghosts = tab.ghosts.filter((g) => !names.has(g.name));
            if (tab.entries.length !== before) {
              if (tab.total != null) tab.total -= before - tab.entries.length;
              tab.selection = pruneSelection(
                tab.selection,
                new Set(tab.entries.map((e) => e.id)),
              );
            }
          }
        }
      });
    },

    addGhosts: (destDir, paths, isDir = false) => {
      set((s) => {
        for (const pane of s.panes) {
          for (const tab of pane.tabs) {
            if (tab.path !== destDir) continue;
            const existing = new Set(tab.entries.map((e) => e.name));
            const ghostNames = new Set(tab.ghosts.map((g) => g.name));
            for (const p of paths) {
              const name = basename(p);
              if (existing.has(name) || ghostNames.has(name)) continue;
              tab.ghosts.push({ id: -(++ghostSeq), name, path: p, isDir });
            }
          }
        }
      });
    },

    upsertEntryNow: (paneId, tabId, entry) => {
      set((s) => {
        const tab = findTab(s, paneId, tabId);
        if (!tab) return;
        const idx = tab.entries.findIndex((e) => e.name === entry.name);
        if (idx >= 0) {
          // keep the row's id stable so selection survives the update
          tab.entries[idx] = { ...entry, id: tab.entries[idx].id };
        } else {
          tab.entries.push(entry);
          tab.entries = sortEntries(tab.entries, tab.sort);
          if (tab.total != null) tab.total += 1;
        }
        tab.ghosts = tab.ghosts.filter((g) => g.name !== entry.name);
      });
    },
  })),
);

// ---------------------------------------------------------------------------
// selectors / cross-store helpers
// ---------------------------------------------------------------------------

/** The rows a tab actually displays: hidden filtered, name-filter applied, display order. */
export function visibleEntries(tab: Pick<Tab, "entries" | "filter" | "showHidden">): Entry[] {
  const q = tab.filter.trim().toLowerCase();
  return tab.entries.filter((e) => {
    if (!tab.showHidden && e.hidden) return false;
    if (q !== "" && !e.name.toLowerCase().includes(q)) return false;
    return true;
  });
}

export function activePaneTab(): { pane: Pane; tab: Tab } | null {
  const paneId = useApp.getState().activePaneId;
  const s = usePanes.getState();
  const pane = s.panes.find((p) => p.id === paneId) ?? s.panes[0];
  if (!pane || pane.tabs.length === 0) return null;
  return { pane, tab: activeTabOf(pane) };
}

/** Entries currently selected in the active tab (in display order). */
export function selectedEntries(): Entry[] {
  const at = activePaneTab();
  if (!at) return [];
  const { tab } = at;
  return tab.entries.filter((e) => tab.selection.selected.has(e.id));
}

export function selectedPaths(): string[] {
  return selectedEntries().map((e) => e.path);
}

export function selectionLabel(): string {
  const n = selectedEntries().length;
  return pluralize(n, "item");
}
