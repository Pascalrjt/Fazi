/**
 * Panes → tabs → listings. The state model the whole frontend hangs off.
 *
 * Listing lifecycle: navigate → new listingId → cancel old listing/watch →
 * listDir streams chunks (arrival order for large dirs, per-chunk re-sort for
 * small) → "listed" settles the sort once → "done" starts the watcher.
 */
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { enableMapSet, setAutoFreeze } from "immer";
import type { Entry, ListErrorCode, ListEvent, WatchEvent } from "../types/ipc";
import * as ipc from "../lib/ipc";
import { dropHydrator, initHydrator } from "../lib/hydration";
import { useDirSizes } from "./dirSizes";
import { safeIpc } from "../lib/safeIpc";
import { mergeSorted, samePosition, sortEntries, type SortDir, type SortKey, type SortSpec } from "../lib/sort";
import { noteEntriesPatched, visibleView, type VisibleView } from "../lib/visibleView";
import {
  emptySelection,
  pruneSelection,
  type SelectionState,
} from "../lib/selection";
import { basename, dirname, joinPath, pluralize } from "../lib/format";
import { useSettings } from "./settings";
import { useApp, type PaneId } from "./app";
import { ejectedByUser, useVolumes } from "./volumes";

enableMapSet();
// Listings (up to ~100k rows) are installed through the plain setState path
// as fresh arrays; with auto-freeze on, the next produce() anywhere would
// deep-freeze them — an O(n) walk over every entry object. Nothing relies on
// frozen state: all updates go through set()/setState with new objects.
setAutoFreeze(false);

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

/** One pane's tabs as restored from a saved session (see stores/session). */
export interface RestoredPane {
  id: PaneId;
  activeIndex: number;
  tabs: Array<{
    path: string;
    sort: SortSpec;
    showHidden: boolean;
    back: HistorySnapshot[];
    forward: HistorySnapshot[];
  }>;
}

interface PanesState {
  panes: Pane[];
  split: boolean;

  // --- lookups ---------------------------------------------------------
  // (plain functions on state; components use fine-grained selectors)

  // --- navigation ------------------------------------------------------
  boot(homePath: string): void;
  /** Replace all panes with a saved layout and start their listings. */
  restore(panes: RestoredPane[], split: boolean): void;
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
  /**
   * Drag-reorder: move a tab to insertion index `toIndex` (counted in the
   * target pane before the move) within its pane or into the other pane.
   * Emptying the right pane closes dual pane; the left pane's last tab
   * stays put.
   */
  moveTab(fromPane: PaneId, tabId: string, toPane: PaneId, toIndex: number): void;
  cycleTab(paneId: PaneId, delta: 1 | -1): void;
  setSplit(split: boolean, initialPath?: string): void;

  // --- listing plumbing --------------------------------------------------
  applyListEvent(paneId: PaneId, tabId: string, listingId: string, event: ListEvent): void;
  finishHydration(paneId: PaneId, tabId: string, listingId: string): void;
  applyWatchBatch(paneId: PaneId, tabId: string, watchId: string, event: WatchEvent): void;
  /** A volume mounted at `root` went away: every tab on it walks up to the
   *  nearest surviving ancestor. FSEvents only reports the unmount to a
   *  watcher rooted AT the mount point, so tabs in subfolders need this. */
  volumeGone(root: string): void;

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

/**
 * Pass-1 chunks live outside Immer until they are committed. Pushing every
 * 1,000-row chunk into an Immer draft makes Immer repeatedly finalize the
 * growing array, which becomes effectively quadratic for 100k directories.
 */
interface ListingIngest {
  paneId: PaneId;
  tabId: string;
  listingId: string;
  entries: Entry[];
  committed: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

const INGEST_COMMIT_MS = 100;
const listingIngest = new Map<string, ListingIngest>();
const listingIndexes = new Map<string, Map<number, number>>();

function entryIndex(entries: readonly Entry[]): Map<number, number> {
  const m = new Map<number, number>();
  for (let i = 0; i < entries.length; i++) m.set(entries[i].id, i);
  return m;
}

/** Entry positions changed: drop the id→index map; the next hydration
 *  merge rebuilds it on demand instead of every edit paying O(n). */
function invalidateIndex(listingId: string | undefined): void {
  if (listingId) listingIndexes.delete(listingId);
}

/** Replace one tab (any listing) through the plain path; `update` returning
 *  the same tab is a no-op. */
function updateTabPlain(paneId: PaneId, tabId: string, update: (tab: Tab) => Tab): Tab | null {
  const tab = findTab(usePanes.getState(), paneId, tabId);
  if (!tab) return null;
  const next = replaceTabPlain(paneId, tabId, tab.listingId, update);
  return next === tab ? null : next;
}

/** Replace one tab through Zustand's plain-object path, bypassing Immer. */
function replaceTabPlain(
  paneId: PaneId,
  tabId: string,
  listingId: string,
  update: (tab: Tab) => Tab,
): Tab | null {
  const state = usePanes.getState();
  const paneIndex = state.panes.findIndex((pane) => pane.id === paneId);
  if (paneIndex < 0) return null;
  const pane = state.panes[paneIndex];
  const tabIndex = pane.tabs.findIndex((tab) => tab.id === tabId);
  if (tabIndex < 0 || pane.tabs[tabIndex].listingId !== listingId) return null;

  const nextTab = update(pane.tabs[tabIndex]);
  if (nextTab === pane.tabs[tabIndex]) return nextTab; // unchanged
  const tabs = pane.tabs.slice();
  tabs[tabIndex] = nextTab;
  const panes = state.panes.slice();
  panes[paneIndex] = { ...pane, tabs };
  usePanes.setState({ panes });
  return nextTab;
}

function dropListingCaches(listingId: string): void {
  const ingest = listingIngest.get(listingId);
  if (ingest?.timer != null) clearTimeout(ingest.timer);
  listingIngest.delete(listingId);
  listingIndexes.delete(listingId);
}

function commitIngest(ingest: ListingIngest, total?: number): void {
  if (ingest.timer != null) {
    clearTimeout(ingest.timer);
    ingest.timer = null;
  }
  const current = findTab(usePanes.getState(), ingest.paneId, ingest.tabId);
  if (!current || current.listingId !== ingest.listingId) {
    dropListingCaches(ingest.listingId);
    return;
  }

  const settled = total != null;
  const entries =
    settled || ingest.entries.length <= RESORT_THRESHOLD
      ? sortEntries(ingest.entries, current.sort)
      : ingest.entries.slice();
  const next = replaceTabPlain(ingest.paneId, ingest.tabId, ingest.listingId, (tab) => {
    const updated: Tab = {
      ...tab,
      entries,
      loading: false,
      listed: settled ? true : tab.listed,
      total: settled ? total : tab.total,
      sorting: settled ? false : ingest.entries.length > RESORT_THRESHOLD,
    };
    if (settled) applyRestore(updated);
    return updated;
  });
  ingest.committed = next != null;
  if (settled && next) {
    listingIndexes.set(ingest.listingId, entryIndex(entries));
    listingIngest.delete(ingest.listingId);
  }
}

function ingestChunk(
  paneId: PaneId,
  tabId: string,
  listingId: string,
  entries: Entry[],
): void {
  const tab = findTab(usePanes.getState(), paneId, tabId);
  if (!tab || tab.listingId !== listingId) return;
  let ingest = listingIngest.get(listingId);
  if (!ingest) {
    ingest = { paneId, tabId, listingId, entries: tab.entries.slice(), committed: false, timer: null };
    listingIngest.set(listingId, ingest);
  }
  ingest.entries.push(...entries);

  // First paint is synchronous. Later chunks are coalesced so a 100k listing
  // commits around ten times instead of finalizing one hundred growing drafts.
  if (!ingest.committed) {
    commitIngest(ingest);
  } else if (ingest.timer == null) {
    ingest.timer = setTimeout(() => commitIngest(ingest as ListingIngest), INGEST_COMMIT_MS);
  }
}

function settleIngest(paneId: PaneId, tabId: string, listingId: string, total: number): void {
  const tab = findTab(usePanes.getState(), paneId, tabId);
  if (!tab || tab.listingId !== listingId) return;
  const ingest = listingIngest.get(listingId) ?? {
    paneId,
    tabId,
    listingId,
    entries: tab.entries.slice(),
    committed: true,
    timer: null,
  };
  listingIngest.set(listingId, ingest);
  commitIngest(ingest, total);
}

function mergeHydrationPlain(
  paneId: PaneId,
  tabId: string,
  listingId: string,
  patches: Entry[],
): void {
  const tab = findTab(usePanes.getState(), paneId, tabId);
  if (!tab || tab.listingId !== listingId || patches.length === 0) return;

  let indexes = listingIndexes.get(listingId);
  if (!indexes || indexes.size !== tab.entries.length) {
    indexes = entryIndex(tab.entries);
    listingIndexes.set(listingId, indexes);
  }
  const entries = tab.entries.slice();
  const patched: number[] = [];
  for (const patch of patches) {
    const index = indexes.get(patch.id);
    if (index == null || entries[index]?.id !== patch.id) continue;
    entries[index] = patch;
    patched.push(index);
  }
  if (patched.length === 0) return;
  // Same ids at the same positions: visible views derive incrementally.
  noteEntriesPatched(tab.entries, entries, patched);

  const hydratedNames = new Set(patches.map((entry) => entry.name));
  replaceTabPlain(paneId, tabId, listingId, (current) => ({
    ...current,
    entries,
    ghosts:
      current.ghosts.length === 0
        ? current.ghosts
        : current.ghosts.filter((ghost) => !hydratedNames.has(ghost.name)),
    // Hydration can change size/kind/time ordering. Settle once at channel
    // Done or when the client-side hydrator drains, never once per batch.
    sorting: current.listed ? true : current.sorting,
  }));
}

/** Above this share of new rows, one full sort beats merging. */
const MERGE_MAX_FRACTION = 0.125;

/**
 * Apply one watcher delta to a PLAIN tab, returning a new tab (or the same
 * tab when nothing changed). Removals match names exactly; upserts match
 * case-insensitively (APFS) and replace in place keeping the row id, so
 * selection survives; new names are merged into sort order in one pass.
 * Exported for tests and benchmarks.
 */
export function applyWatchDelta(
  tab: Tab,
  removedNames: readonly string[],
  upserts: readonly Entry[],
): Tab {
  let entries = tab.entries;
  let ghosts = tab.ghosts;
  let total = tab.total;
  let selection = tab.selection;

  if (removedNames.length > 0) {
    const gone = new Set(removedNames);
    const removedIds = new Set<number>();
    const kept: Entry[] = [];
    for (const e of entries) {
      if (gone.has(e.name)) removedIds.add(e.id);
      else kept.push(e);
    }
    if (ghosts.some((g) => gone.has(g.name))) ghosts = ghosts.filter((g) => !gone.has(g.name));
    if (removedIds.size > 0) {
      entries = kept;
      if (total != null) total -= removedIds.size;
      selection = pruneSelection(selection, { has: (id) => !removedIds.has(id) });
    }
  }

  if (upserts.length > 0) {
    // folded name → index, built once per batch
    const byFolded = new Map<string, number>();
    for (let i = 0; i < entries.length; i++) {
      const folded = entries[i].name.toLocaleLowerCase();
      if (!byFolded.has(folded)) byFolded.set(folded, i); // first match wins
    }
    let patched: Entry[] | null = null;
    // Replaced rows whose sort inputs changed (size, mtime, kind, name…):
    // pulled out and merged back with the additions so order holds.
    const displaced = new Set<number>();
    const additions: Entry[] = [];
    const addedAt = new Map<string, number>();
    const foldedUpserts = new Set<string>();
    for (const entry of upserts) {
      const folded = entry.name.toLocaleLowerCase();
      foldedUpserts.add(folded);
      const idx = byFolded.get(folded);
      if (idx != null) {
        patched ??= entries.slice();
        // keep the row's id stable so selection survives the update
        const next = { ...entry, id: patched[idx].id };
        if (!samePosition(entries[idx], next, tab.sort)) displaced.add(idx);
        else displaced.delete(idx);
        patched[idx] = next;
        continue;
      }
      const at = addedAt.get(folded);
      if (at != null) {
        additions[at] = { ...entry, id: additions[at].id };
      } else {
        addedAt.set(folded, additions.length);
        additions.push(entry);
      }
    }
    const added = additions.length;
    if (patched) {
      entries = patched;
      if (displaced.size > 0) {
        const kept: Entry[] = [];
        for (let i = 0; i < patched.length; i++) {
          if (displaced.has(i)) additions.push(patched[i]);
          else kept.push(patched[i]);
        }
        // `kept` is a subsequence of the sorted rows, so still sorted.
        entries = kept;
      }
    }
    if (additions.length > 0) {
      entries =
        tab.sorting || additions.length > entries.length * MERGE_MAX_FRACTION
          ? sortEntries([...entries, ...additions], tab.sort)
          : mergeSorted(entries, additions, tab.sort);
      if (total != null) total += added;
    }
    if (ghosts.some((g) => foldedUpserts.has(g.name.toLocaleLowerCase()))) {
      ghosts = ghosts.filter((g) => !foldedUpserts.has(g.name.toLocaleLowerCase()));
    }
  }

  if (
    entries === tab.entries &&
    ghosts === tab.ghosts &&
    total === tab.total &&
    selection === tab.selection
  ) {
    return tab;
  }
  return { ...tab, entries, ghosts, total, selection };
}

/** Commit a watcher delta for the listing it was observed on. */
function applyWatchDeltaPlain(
  paneId: PaneId,
  tabId: string,
  listingId: string,
  removedNames: readonly string[],
  upserts: readonly Entry[],
): void {
  const next = replaceTabPlain(paneId, tabId, listingId, (tab) =>
    applyWatchDelta(tab, removedNames, upserts),
  );
  if (next) invalidateIndex(listingId);
}

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

/** Restart every tab's listing in a pane (after its id changed). */
function relistPane(get: () => PanesState, paneId: PaneId): void {
  const pane = findPane(get(), paneId);
  for (const tab of pane?.tabs ?? []) get().refresh(paneId, tab.id);
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

/** First existing ancestor of `path` (strictly above it), else "/". Used
 *  when a watched root vanishes — a whole volume unmounting takes the
 *  immediate parent with it. */
export async function nearestExistingAncestor(
  path: string,
  exists: (p: string) => Promise<boolean>,
): Promise<string> {
  let cur = dirname(path) ?? "/";
  while (cur !== "/") {
    if (await exists(cur)) return cur;
    cur = dirname(cur) ?? "/";
  }
  return "/";
}

/** History snapshot of a PLAIN tab (never an Immer draft: walking a draft's
 *  100k entries creates a proxy per row). Only selected/lead rows are mapped. */
export function snapshot(tab: Tab): HistorySnapshot {
  const { selected, lead } = tab.selection;
  const nameOf = new Map<number, string>();
  if (selected.size > 0 || lead != null) {
    for (const e of tab.entries) {
      if (selected.has(e.id) || e.id === lead) nameOf.set(e.id, e.name);
    }
  }
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
    dropListingCaches(tab.listingId);
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

/** listingId → tail of its watcher stat chain (see the "batch" case). */
const watcherStats = new Map<string, Promise<void>>();

/** `${tabId}\0${path}` of vanished-root recoveries in flight: an unmount at
 *  the tab's own root reports through BOTH the watcher and the volume list. */
const recovering = new Set<string>();

/** The tab's folder vanished (watcher rootGone, or its volume unmounted):
 *  walk up to the nearest SURVIVING ancestor — after an eject the immediate
 *  parent (and everything up to /Volumes) may be gone too. */
function recoverVanishedTab(paneId: PaneId, tabId: string, from: string, listingId: string): void {
  const key = `${tabId}\0${from}`;
  if (recovering.has(key)) return;
  recovering.add(key);
  // A user-initiated eject already reports "Ejected “X”".
  if (!ejectedByUser(from)) {
    useApp.getState().pushToast(`“${basename(from)}” is no longer available`);
  }
  void (async () => {
    try {
      const dest = await nearestExistingAncestor(from, (p) =>
        ipc
          .statPath(p, listingId)
          .then((e) => e != null)
          .catch(() => false),
      );
      const s = usePanes.getState();
      const t = s.panes.find((p) => p.id === paneId)?.tabs.find((tt) => tt.id === tabId);
      // Only navigate if the tab still shows the vanished dir.
      if (t && t.path === from) s.navigate(paneId, tabId, dest);
    } finally {
      recovering.delete(key);
    }
  })();
}

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

    restore: (restored, split) => {
      const current = get();
      for (const pane of current.panes) for (const t of pane.tabs) stopListing(t);
      set((s) => {
        s.panes = restored.map((rp) => {
          const tabs = rp.tabs.map((rt) => {
            const tab = newTab(rt.path);
            tab.sort = rt.sort;
            tab.showHidden = rt.showHidden;
            tab.back = rt.back;
            tab.forward = rt.forward;
            return tab;
          });
          const active = tabs[Math.min(Math.max(rp.activeIndex, 0), tabs.length - 1)];
          return { id: rp.id, tabs, activeTabId: active.id };
        });
        s.split = split && s.panes.some((p) => p.id === "right");
      });
      for (const pane of get().panes) {
        for (const t of pane.tabs) startListing(set, get, pane.id, t.id);
      }
    },

    navigate: (paneId, tabId, path, opts) => {
      const plain = findTab(get(), paneId, tabId);
      const snap = plain && (plain.path !== path || plain.error) ? snapshot(plain) : null;
      set((s) => {
        const tab = findTab(s, paneId, tabId);
        if (!tab) return;
        stopListing(tab);
        if (snap) {
          tab.back.push(snap);
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
      const plain = findTab(get(), paneId, tabId);
      const snap = plain ? snapshot(plain) : null;
      set((s) => {
        const tab = findTab(s, paneId, tabId);
        if (!tab || !snap) return;
        stopListing(tab);
        const keep: PendingRestore = {
          scrollTop: tab.scrollTop,
          selectNames: snap.selectedNames,
          leadName: snap.leadName ?? undefined,
        };
        resetForNavigation(tab, tab.path);
        tab.pendingRestore = keep;
      });
      startListing(set, get, paneId, tabId);
    },

    back: (paneId, tabId) => {
      let target: HistorySnapshot | undefined;
      const plain = findTab(get(), paneId, tabId);
      if (!plain || plain.back.length === 0) return;
      const snap = snapshot(plain);
      set((s) => {
        const tab = findTab(s, paneId, tabId);
        if (!tab || tab.back.length === 0) return;
        target = tab.back.pop();
        tab.forward.push(snap);
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
      const plain = findTab(get(), paneId, tabId);
      if (!plain || plain.forward.length === 0) return;
      const snap = snapshot(plain);
      set((s) => {
        const tab = findTab(s, paneId, tabId);
        if (!tab || tab.forward.length === 0) return;
        target = tab.forward.pop();
        tab.back.push(snap);
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
        // Open right below the active tab, so a new tab stays next to the
        // one it came from (and in view in the vertical tab list). Opening
        // several folders in a row keeps their order: each lands below the
        // previous one, which became active.
        const at = pane.tabs.findIndex((t) => t.id === pane.activeTabId);
        pane.tabs.splice(at === -1 ? pane.tabs.length : at + 1, 0, tab);
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
          let renamed = false;
          set((s) => {
            s.panes = s.panes.filter((p) => p.id !== paneId);
            s.split = false;
            // the surviving pane always becomes "left" (PaneArea renders it)
            if (s.panes.length === 1 && s.panes[0].id !== "left") {
              s.panes[0].id = "left";
              renamed = true;
            }
          });
          // Listings and watchers are keyed by pane id; restart them under
          // the new id or the pane stops receiving updates.
          if (renamed) relistPane(get, "left");
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

    moveTab: (fromPane, tabId, toPane, toIndex) => {
      const state = get();
      const src = findPane(state, fromPane);
      const dst = findPane(state, toPane);
      if (!src || !dst) return;
      const from = src.tabs.findIndex((t) => t.id === tabId);
      if (from === -1) return;
      const clamp = (n: number, max: number) => Math.max(0, Math.min(n, max));

      if (fromPane === toPane) {
        // toIndex is an insertion index into the pre-removal array.
        const target = from < toIndex ? toIndex - 1 : toIndex;
        if (target === from) return;
        set((s) => {
          const p = findPane(s, fromPane);
          if (!p) return;
          const [tab] = p.tabs.splice(from, 1);
          p.tabs.splice(clamp(target, p.tabs.length), 0, tab);
        });
        return;
      }

      // Moving the left pane's only tab out would leave it empty.
      if (fromPane === "left" && src.tabs.length === 1) return;

      let renamed = false;
      set((s) => {
        const sp = findPane(s, fromPane);
        const dp = findPane(s, toPane);
        if (!sp || !dp) return;
        const [tab] = sp.tabs.splice(from, 1);
        dp.tabs.splice(clamp(toIndex, dp.tabs.length), 0, tab);
        dp.activeTabId = tab.id;
        if (sp.tabs.length === 0) {
          s.panes = s.panes.filter((p) => p.id !== fromPane);
          s.split = false;
          if (s.panes[0].id !== "left") {
            s.panes[0].id = "left";
            renamed = true;
          }
        } else if (sp.activeTabId === tabId) {
          sp.activeTabId = sp.tabs[Math.min(from, sp.tabs.length - 1)].id;
        }
      });
      // Listings are keyed by pane id: restart the moved tab (or the whole
      // renamed pane) under its new pane.
      const landed: PaneId = renamed ? "left" : toPane;
      if (renamed) relistPane(get, landed);
      else get().refresh(landed, tabId);
      useApp.getState().setActivePane(landed);
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
      if (event.event === "chunk") {
        ingestChunk(paneId, tabId, listingId, event.entries);
        return;
      }
      if (event.event === "listed") {
        settleIngest(paneId, tabId, listingId, event.total);
        return;
      }
      if (event.event === "hydrate") {
        mergeHydrationPlain(paneId, tabId, listingId, event.entries);
        return;
      }

      // Sort the plain array, never the draft (a draft walk proxies each row).
      const plainTab = findTab(get(), paneId, tabId);
      const settleSorted =
        event.event === "done" && plainTab && plainTab.listingId === listingId && !plainTab.listed
          ? sortEntries(plainTab.entries, plainTab.sort)
          : null;
      set((s) => {
        const tab = findTab(s, paneId, tabId);
        if (!tab || tab.listingId !== listingId) return; // stale listing
        switch (event.event) {
          case "done": {
            tab.loading = false;
            if (!tab.listed) {
              tab.listed = true;
              tab.total = settleSorted?.length ?? tab.entries.length;
              tab.entries = settleSorted ?? sortEntries(tab.entries, tab.sort);
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
      if (settleSorted) invalidateIndex(listingId);
      if (event.event === "done") {
        let tab = findTab(get(), paneId, tabId);
        if (!tab || tab.listingId !== listingId || tab.error) return;
        // Big listing (pass 2 skipped server-side): hand the unhydrated rows
        // to the shared viewport-priority scheduler.
        if (tab.entries.some((e) => !e.hydrated)) {
          initHydrator(paneId, tabId, listingId, tab.entries);
        } else {
          get().finishHydration(paneId, tabId, listingId);
        }
        tab = findTab(get(), paneId, tabId);
        if (!tab || tab.listingId !== listingId) return;
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

    finishHydration: (paneId, tabId, listingId) => {
      const tab = findTab(get(), paneId, tabId);
      if (!tab || tab.listingId !== listingId || !tab.sorting) return;
      const entries = sortEntries(tab.entries, tab.sort);
      const next = replaceTabPlain(paneId, tabId, listingId, (current) => ({
        ...current,
        entries,
        sorting: false,
      }));
      if (next) listingIndexes.set(listingId, entryIndex(entries));
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
          const changed = [...event.upserted, ...event.removed].map((name) =>
            joinPath(tab.path, name),
          );
          if (changed.length > 0) useDirSizes.getState().invalidate(changed);
          const key = tab.listingId;
          const removed = event.removed;
          const apply = (upserts: readonly Entry[]) =>
            applyWatchDeltaPlain(paneId, tabId, key, removed, upserts);
          if (event.upserted.length === 0) {
            if (removed.length === 0) return;
            // Nothing ahead in the chain: remove now.
            if (!watcherStats.has(key)) {
              apply([]);
              return;
            }
          }
          // Stats run on backend worker threads and may resolve out of
          // order: request now (one bulk stat per batch), but apply each
          // batch — removals and upserts together, as ONE plain update — in
          // batch order, so an older stat never overwrites a newer one and a
          // removal never lands before an earlier batch's upsert of the name.
          let request: Promise<Array<Entry | null>> = Promise.resolve([]);
          if (event.upserted.length > 0) {
            const paths = event.upserted.map((name) => joinPath(tab.path, name));
            request = ipc.statPaths(tab.listingId, paths);
            request.catch(() => {}); // handled in the chain; avoid an early unhandled rejection
          }
          const applied = (watcherStats.get(key) ?? Promise.resolve())
            .then(() => request)
            .then(
              (entries) => apply(entries.filter((e): e is Entry => e != null)),
              () => apply([]), // stat failed: the removals still apply
            )
            .catch(() => {});
          watcherStats.set(key, applied);
          void applied.then(() => {
            if (watcherStats.get(key) === applied) watcherStats.delete(key);
          });
          break;
        }
        case "rootGone": {
          recoverVanishedTab(paneId, tabId, tab.path, tab.listingId);
          break;
        }
        default: {
          const _exhaustive: never = event;
          void _exhaustive;
        }
      }
    },

    volumeGone: (root) => {
      for (const pane of get().panes) {
        for (const tab of pane.tabs) {
          if (tab.path === root || tab.path.startsWith(`${root}/`)) {
            recoverVanishedTab(pane.id, tab.id, tab.path, tab.listingId);
          }
        }
      }
    },

    setSort: (paneId, tabId, key, dir) => {
      const tab = updateTabPlain(paneId, tabId, (t) => {
        const nextDir: SortDir =
          dir ?? (t.sort.key === key ? (t.sort.dir === "asc" ? "desc" : "asc") : "asc");
        const sort: SortSpec = { key, dir: nextDir };
        return { ...t, sort, entries: sortEntries(t.entries, sort) };
      });
      if (tab) {
        invalidateIndex(tab.listingId);
        useSettings.getState().setDefaultSort(tab.sort.key, tab.sort.dir);
      }
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
      // Scan the plain entries, then commit only the selection.
      const plain = findTab(get(), paneId, tabId);
      if (!plain) return;
      const wanted = new Set(names);
      const selected = new Set<number>();
      let lead: number | null = null;
      for (const e of plain.entries) {
        if (wanted.has(e.name)) {
          selected.add(e.id);
          lead = e.id;
        }
      }
      set((s) => {
        const tab = findTab(s, paneId, tabId);
        if (tab) tab.selection = { selected, anchor: lead, lead };
      });
    },

    renameLocal: (paneId, tabId, entryId, newName, newPath) => {
      const tab = updateTabPlain(paneId, tabId, (t) => {
        const idx = t.entries.findIndex((e) => e.id === entryId);
        if (idx === -1) return t;
        const old = t.entries[idx];
        const dotIdx = newName.lastIndexOf(".");
        const ext = dotIdx > 0 ? newName.slice(dotIdx + 1).toLowerCase() : "";
        const entries = t.entries.slice();
        entries[idx] = {
          ...old,
          name: newName,
          path: newPath,
          ext,
          hidden: newName.startsWith("."),
        };
        return { ...t, entries: sortEntries(entries, t.sort) };
      });
      if (tab) invalidateIndex(tab.listingId);
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
      // Plain arrays, one commit: filtering draft entries proxies every row.
      let touched = false;
      const panes = get().panes.map((pane) => {
        let tabsChanged = false;
        const tabs = pane.tabs.map((tab) => {
          const names = byDir.get(tab.path);
          if (!names) return tab;
          const next = applyWatchDelta(tab, [...names], []);
          if (next !== tab) tabsChanged = true;
          if (next.entries !== tab.entries) invalidateIndex(tab.listingId);
          return next;
        });
        if (!tabsChanged) return pane;
        touched = true;
        return { ...pane, tabs };
      });
      if (touched) usePanes.setState({ panes });
    },

    addGhosts: (destDir, paths, isDir = false) => {
      // Name lookups against the plain entries; only the small ghost lists
      // go through the draft.
      const additions = new Map<string, GhostEntry[]>();
      for (const pane of get().panes) {
        for (const tab of pane.tabs) {
          if (tab.path !== destDir) continue;
          const existing = new Set<string>();
          for (const e of tab.entries) existing.add(e.name);
          const ghostNames = new Set(tab.ghosts.map((g) => g.name));
          const add: GhostEntry[] = [];
          for (const p of paths) {
            const name = basename(p);
            if (existing.has(name) || ghostNames.has(name)) continue;
            add.push({ id: -(++ghostSeq), name, path: p, isDir });
          }
          if (add.length > 0) additions.set(`${pane.id}\0${tab.id}`, add);
        }
      }
      if (additions.size === 0) return;
      set((s) => {
        for (const pane of s.panes) {
          for (const tab of pane.tabs) {
            const add = additions.get(`${pane.id}\0${tab.id}`);
            if (add) tab.ghosts.push(...add);
          }
        }
      });
    },

    upsertEntryNow: (paneId, tabId, entry) => {
      const next = updateTabPlain(paneId, tabId, (tab) => applyWatchDelta(tab, [], [entry]));
      if (next) invalidateIndex(next.listingId);
    },
  })),
);

// ---------------------------------------------------------------------------
// selectors / cross-store helpers
// ---------------------------------------------------------------------------

/** The rows a tab actually displays: hidden filtered, name-filter applied, display order. */
export function visibleEntries(tab: Pick<Tab, "entries" | "filter" | "showHidden">): Entry[] {
  return visibleView(tab).entries;
}

/** Cached visible view (rows, ids, id→index, lowercased names); see lib/visibleView. */
export function tabView(tab: Pick<Tab, "entries" | "filter" | "showHidden">): VisibleView {
  return visibleView(tab);
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

// Volumes that drop out of the mounted list take their tabs with them.
useVolumes.subscribe((now, prev) => {
  if (now.volumes === prev.volumes || !prev.loaded) return;
  const mounted = new Set(now.volumes.map((v) => v.path));
  for (const v of prev.volumes) {
    if (!v.isRoot && !mounted.has(v.path)) usePanes.getState().volumeGone(v.path);
  }
});
