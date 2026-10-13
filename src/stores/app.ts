/** App-level UI state: active pane, palette, clipboard mirror, toasts, overlays. */
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { FuzzyFilters, SearchEvent } from "../types/ipc";
import * as ipc from "../lib/ipc";
import { safeIpc } from "../lib/safeIpc";
import { parseSearchQuery } from "../lib/searchQuery";
import { useSettings } from "./settings";

/** Sections of the Settings tab, in section-bar order. */
export type SettingsSectionId =
  | "general"
  | "appearance"
  | "sidebar"
  | "keyboard"
  | "search"
  | "transfers"
  | "cleanup"
  | "reset";

/**
 * Not-indexed fallback: one-shot (live: false) fuzzy query with its own
 * lifecycle — queryId "search-<searchId>", never occupying the ⌘P live slot,
 * cancelled alongside the mdfind child on replacement/close.
 */
function runFallback(
  searchId: string,
  scopePath: string,
  text: string,
  filters: FuzzyFilters,
  maxResults: number,
): void {
  const queryId = `search-${searchId}`;
  useApp.setState((s) => {
    s.globalSearch.usedFallback = true;
    s.globalSearch.indexed = false;
    s.globalSearch.fallbackQueryId = queryId;
  });
  const settings = useSettings.getState();
  const fail = (err: unknown) => {
    if (useApp.getState().globalSearch.searchId !== searchId) return;
    useApp.setState((s) => {
      s.globalSearch.status = "error";
      s.globalSearch.error = String(err);
    });
  };
  safeIpc(() =>
    ipc.fuzzyWarm(scopePath, settings.fuzzyExcludes, settings.fuzzyIndexEntryCap),
  )
    .then(() =>
      ipc.fuzzyQuery(
        {
          root: scopePath,
          query: text,
          queryId,
          // The fallback's K is the search cap — never silently truncated
          // at the overlay's 100.
          maxResults,
          live: false,
          filters,
        },
        (e) => {
          if (useApp.getState().globalSearch.searchId !== searchId) return;
          if (e.event === "results") {
            useApp.setState((s) => {
              s.globalSearch.hits = e.items.map((i) => ({
                path: i.path,
                name: i.name,
                isDir: i.isDir,
                icon: i.icon,
              }));
            });
          } else if (e.event === "done") {
            useApp.setState((s) => {
              s.globalSearch.status = "done";
              s.globalSearch.total = s.globalSearch.hits.length;
              s.globalSearch.capped = e.capped;
              s.globalSearch.fallbackQueryId = null;
            });
          }
        },
      ),
    )
    .catch(fail);
}

export type PaneId = "left" | "right";

export interface Toast {
  id: number;
  message: string;
  action?: { label: string; run: () => void };
  danger?: boolean;
  /** What the countdown ring shows: it drains from `from` (fraction of the
   *  lifetime left) to empty over `ms`, or stays at `from` while held. */
  countdown: { from: number; ms: number; held: boolean };
}

export interface RenameTarget {
  paneId: PaneId;
  tabId: string;
  entryId: number;
}

export interface ConfirmDialog {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
}

export type SearchScope = "folder" | "home" | "mac";

export interface SearchHit {
  path: string;
  name: string;
  isDir: boolean;
  icon: string;
}

interface GlobalSearch {
  active: boolean;
  query: string;
  scope: SearchScope;
  contents: boolean;
  hits: SearchHit[];
  status: "idle" | "searching" | "done" | "error";
  total: number | null;
  error: string | null;
  searchId: string | null;
  /** The result cap truncated the stream — more matches exist. */
  capped: boolean;
  /** Spotlight indexing enabled on the scope's volume. */
  indexed: boolean;
  /** Results came from the fuzzy walker (Spotlight index unavailable). */
  usedFallback: boolean;
  /** In-flight fallback fuzzy query ("search-<searchId>") — cancelled with the search. */
  fallbackQueryId: string | null;
}

const EMPTY_SEARCH: GlobalSearch = {
  active: false,
  query: "",
  scope: "folder",
  contents: false,
  hits: [],
  status: "idle",
  total: null,
  error: null,
  searchId: null,
  capped: false,
  indexed: true,
  usedFallback: false,
  fallbackQueryId: null,
};

/** Streamed hits buffer up here and flush every ~50 ms / 200 hits — 10k
 *  single-hit set() calls would storm re-renders. */
const hitBuffers = new Map<string, SearchHit[]>();
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
const FLUSH_MS = 50;
const FLUSH_COUNT = 200;

interface AppState {
  activePaneId: PaneId;
  paletteOpen: boolean;
  /** Mirror of the pasteboard for cut-dimming (source of truth is the OS pasteboard). */
  clipboard: { mode: "copy" | "cut"; paths: string[] } | null;
  toasts: Toast[];
  previewOpen: boolean;
  getInfoOpen: boolean;
  /** The Settings tab exists in the tab list (⌘, opens it, ⌘W closes it). */
  settingsOpen: boolean;
  /** The Settings tab is showing in place of the panes. */
  settingsActive: boolean;
  /** Section shown in the Settings tab. */
  settingsSection: SettingsSectionId;
  /** Settings search; non-empty shows results from every section. */
  settingsQuery: string;
  /** Bump to request focus on the settings search field. */
  settingsSearchFocusSeq: number;
  batchRenameOpen: boolean;
  /** Vim cheat-sheet overlay (g? / palette / status-bar indicator). */
  vimHelpOpen: boolean;
  renaming: RenameTarget | null;
  pathBarEditing: boolean;
  searchFieldFocused: boolean;
  /** Bump to request focus on the toolbar search field. */
  searchFocusSeq: number;
  confirm: ConfirmDialog | null;
  fdaMissing: boolean;
  globalSearch: GlobalSearch;

  setActivePane(id: PaneId): void;
  setPaletteOpen(open: boolean): void;
  setClipboard(clip: { mode: "copy" | "cut"; paths: string[] } | null): void;
  /** Every toast dismisses itself; see `toastLifetime`. */
  pushToast(message: string, opts?: { action?: Toast["action"]; danger?: boolean }): void;
  dismissToast(id: number): void;
  /** Hold a toast while the pointer rests on it; release resumes its countdown. */
  holdToast(id: number): void;
  releaseToast(id: number): void;
  setPreviewOpen(open: boolean): void;
  setGetInfoOpen(open: boolean): void;
  /** Open (and show) the Settings tab, or close it. */
  setSettingsOpen(open: boolean): void;
  /** Show the Settings tab, or switch back to the panes (it stays open). */
  setSettingsActive(active: boolean): void;
  /** Open the Settings tab at a section (palette deep-links). */
  openSettingsPane(section: SettingsSectionId): void;
  setSettingsSection(section: SettingsSectionId): void;
  setSettingsQuery(query: string): void;
  requestSettingsSearchFocus(): void;
  setBatchRenameOpen(open: boolean): void;
  setVimHelpOpen(open: boolean): void;
  startRename(target: RenameTarget): void;
  stopRename(): void;
  setPathBarEditing(v: boolean): void;
  setSearchFieldFocused(v: boolean): void;
  requestSearchFocus(): void;
  showConfirm(dialog: ConfirmDialog): void;
  closeConfirm(): void;
  setFdaMissing(v: boolean): void;

  // global search
  openGlobalSearch(query: string, scope?: SearchScope): void;
  setSearchScope(scope: SearchScope): void;
  setSearchContents(contents: boolean): void;
  runGlobalSearch(query: string, scopePath: string | null): void;
  closeGlobalSearch(): void;
}

let toastSeq = 0;

/** How long a toast stays up: longer when it offers a button or reports a
 *  failure, so there's time to act on it or read it. */
export function toastLifetime(t: Pick<Toast, "action" | "danger">): number {
  if (t.action) return 10_000;
  if (t.danger) return 8_000;
  return 5_000;
}

/** Per-toast countdown. A run drains the ring from `from` to empty over `ms`
 *  and ends at `deadline`; `timer` is unset while the toast is held. */
const toastTimers = new Map<
  number,
  { timer?: ReturnType<typeof setTimeout>; deadline: number; from: number; ms: number }
>();

function clearToastTimer(id: number): void {
  const t = toastTimers.get(id);
  if (t?.timer) clearTimeout(t.timer);
  toastTimers.delete(id);
}

export const useApp = create<AppState>()(
  immer((set, get) => ({
    activePaneId: "left",
    paletteOpen: false,
    clipboard: null,
    toasts: [],
    previewOpen: false,
    getInfoOpen: false,
    settingsOpen: false,
    settingsActive: false,
    settingsSection: "general",
    settingsQuery: "",
    settingsSearchFocusSeq: 0,
    batchRenameOpen: false,
    vimHelpOpen: false,
    renaming: null,
    pathBarEditing: false,
    searchFieldFocused: false,
    searchFocusSeq: 0,
    confirm: null,
    fdaMissing: false,
    globalSearch: { ...EMPTY_SEARCH },

    setActivePane: (id) => set({ activePaneId: id }),
    setPaletteOpen: (open) => set({ paletteOpen: open }),
    setClipboard: (clip) => set({ clipboard: clip }),

    pushToast: (message, opts) => {
      const id = ++toastSeq;
      const ms = toastLifetime(opts ?? {});
      set((s) => {
        s.toasts.push({ id, message, action: opts?.action, danger: opts?.danger, countdown: { from: 1, ms, held: false } });
        while (s.toasts.length > 3) {
          const evicted = s.toasts.shift();
          if (evicted) clearToastTimer(evicted.id);
        }
      });
      runToast(id, 1, ms);
    },

    holdToast: (id) => {
      const t = toastTimers.get(id);
      if (!t?.timer) return;
      clearTimeout(t.timer);
      const left = Math.max(0, t.deadline - Date.now());
      const from = t.ms > 0 ? (t.from * left) / t.ms : 0;
      toastTimers.set(id, { deadline: t.deadline, from, ms: left });
      setCountdown(id, { from, ms: left, held: true });
    },

    releaseToast: (id) => {
      const t = toastTimers.get(id);
      if (!t || t.timer) return;
      // A short floor so a toast doesn't vanish the instant the pointer leaves.
      const ms = Math.max(t.ms, 2_000);
      runToast(id, t.from, ms);
      setCountdown(id, { from: t.from, ms, held: false });
    },

    dismissToast: (id) => {
      clearToastTimer(id);
      set((s) => {
        s.toasts = s.toasts.filter((toast) => toast.id !== id);
      });
    },

    setPreviewOpen: (open) => set({ previewOpen: open }),
    setGetInfoOpen: (open) => set({ getInfoOpen: open }),
    setSettingsOpen: (open) =>
      set(
        open
          ? { settingsOpen: true, settingsActive: true }
          : { settingsOpen: false, settingsActive: false, settingsQuery: "" },
      ),
    setSettingsActive: (active) =>
      set((s) => {
        s.settingsActive = active && s.settingsOpen;
      }),
    openSettingsPane: (section) =>
      set({ settingsOpen: true, settingsActive: true, settingsSection: section, settingsQuery: "" }),
    setSettingsSection: (section) => set({ settingsSection: section, settingsQuery: "" }),
    setSettingsQuery: (query) => set({ settingsQuery: query }),
    requestSettingsSearchFocus: () =>
      set((s) => {
        s.settingsSearchFocusSeq += 1;
      }),
    setBatchRenameOpen: (open) => set({ batchRenameOpen: open }),
    setVimHelpOpen: (open) => set({ vimHelpOpen: open }),
    startRename: (target) => set({ renaming: target }),
    stopRename: () => set({ renaming: null }),
    setPathBarEditing: (v) => set({ pathBarEditing: v }),
    setSearchFieldFocused: (v) => set({ searchFieldFocused: v }),
    requestSearchFocus: () => set((s) => ({ searchFocusSeq: s.searchFocusSeq + 1 })),
    showConfirm: (dialog) => set({ confirm: dialog }),
    closeConfirm: () => set({ confirm: null }),
    setFdaMissing: (v) => set({ fdaMissing: v }),

    openGlobalSearch: (query, scope) => {
      const activating = !get().globalSearch.active;
      set((s) => {
        s.globalSearch.active = true;
        s.globalSearch.query = query;
        if (scope) s.globalSearch.scope = scope;
        if (activating) {
          // Fresh session starts from the user's default mode; the toolbar
          // pill toggles it per-session from there.
          s.globalSearch.contents = useSettings.getState().searchContentsDefault;
        }
      });
    },

    setSearchScope: (scope) => {
      set((s) => {
        s.globalSearch.scope = scope;
      });
    },

    setSearchContents: (contents) => {
      set((s) => {
        s.globalSearch.contents = contents;
      });
    },

    runGlobalSearch: (query, scopePath) => {
      const prevSearch = get().globalSearch;
      if (prevSearch.searchId) {
        void ipc.cancelSearch(prevSearch.searchId).catch(() => {});
        hitBuffers.delete(prevSearch.searchId);
        const t = flushTimers.get(prevSearch.searchId);
        if (t) clearTimeout(t);
        flushTimers.delete(prevSearch.searchId);
      }
      // Replacing/closing also cancels any in-flight fallback fuzzy query
      // (revoking its icon-token owner scope).
      if (prevSearch.fallbackQueryId) {
        void ipc.fuzzyCancel(prevSearch.fallbackQueryId).catch(() => {});
      }
      if (query.trim() === "") {
        set((s) => {
          s.globalSearch.hits = [];
          s.globalSearch.status = "idle";
          s.globalSearch.total = null;
          s.globalSearch.searchId = null;
          s.globalSearch.capped = false;
          s.globalSearch.usedFallback = false;
          s.globalSearch.fallbackQueryId = null;
        });
        return;
      }
      const { text, filters, hasFilters } = parseSearchQuery(query);
      const contents = get().globalSearch.contents;
      const maxResults = useSettings.getState().searchMaxResults;
      const searchId = crypto.randomUUID();
      set((s) => {
        s.globalSearch.searchId = searchId;
        s.globalSearch.status = "searching";
        s.globalSearch.hits = [];
        s.globalSearch.total = null;
        s.globalSearch.error = null;
        s.globalSearch.capped = false;
        s.globalSearch.indexed = true;
        s.globalSearch.usedFallback = false;
        s.globalSearch.fallbackQueryId = null;
      });

      const flush = () => {
        const buf = hitBuffers.get(searchId);
        flushTimers.delete(searchId);
        if (!buf || buf.length === 0) return;
        hitBuffers.set(searchId, []);
        if (useApp.getState().globalSearch.searchId !== searchId) return;
        set((s) => {
          s.globalSearch.hits.push(...buf);
        });
      };

      const onEvent = (e: SearchEvent) => {
        if (useApp.getState().globalSearch.searchId !== searchId) return;
        switch (e.event) {
          case "hit": {
            const buf = hitBuffers.get(searchId) ?? [];
            buf.push({ path: e.path, name: e.name, isDir: e.isDir, icon: e.icon });
            hitBuffers.set(searchId, buf);
            if (buf.length >= FLUSH_COUNT) {
              flush();
            } else if (!flushTimers.has(searchId)) {
              flushTimers.set(searchId, setTimeout(flush, FLUSH_MS));
            }
            break;
          }
          case "done": {
            flush();
            hitBuffers.delete(searchId);
            // Not-indexed volume: automatically re-run the residual text via
            // the fuzzy walker. Explicitly disabled for This Mac (no single
            // volume; scopePath is null) and Contents mode (the walker
            // matches names only).
            if (!e.indexed && scopePath != null && !contents) {
              runFallback(searchId, scopePath, text, filters, maxResults);
              return;
            }
            set((s) => {
              s.globalSearch.status = "done";
              s.globalSearch.total = e.total;
              s.globalSearch.capped = e.capped;
              s.globalSearch.indexed = e.indexed;
            });
            break;
          }
          case "error":
            set((s) => {
              s.globalSearch.status = "error";
              s.globalSearch.error = e.message;
            });
            break;
          default: {
            const _exhaustive: never = e;
            void _exhaustive;
          }
        }
      };
      safeIpc(() =>
        ipc.search(
          {
            searchId,
            query: text,
            scope: scopePath,
            contents,
            filters: hasFilters ? filters : undefined,
            maxResults,
          },
          onEvent,
        ),
      )
        .catch((err) => {
          if (useApp.getState().globalSearch.searchId !== searchId) return;
          set((s) => {
            s.globalSearch.status = "error";
            s.globalSearch.error = String(err);
          });
        });
    },

    closeGlobalSearch: () => {
      const prev = get().globalSearch;
      if (prev.searchId) {
        void ipc.cancelSearch(prev.searchId).catch(() => {});
        hitBuffers.delete(prev.searchId);
        const t = flushTimers.get(prev.searchId);
        if (t) clearTimeout(t);
        flushTimers.delete(prev.searchId);
      }
      if (prev.fallbackQueryId) {
        void ipc.fuzzyCancel(prev.fallbackQueryId).catch(() => {});
      }
      set((s) => {
        s.globalSearch = { ...EMPTY_SEARCH };
      });
    },
  })),
);

/** Convenience for commands. */
export function toast(message: string, opts?: Parameters<AppState["pushToast"]>[1]): void {
  useApp.getState().pushToast(message, opts);
}

/** Start (or resume) a toast's countdown run. */
function runToast(id: number, from: number, ms: number): void {
  toastTimers.set(id, {
    timer: setTimeout(() => useApp.getState().dismissToast(id), ms),
    deadline: Date.now() + ms,
    from,
    ms,
  });
}

function setCountdown(id: number, countdown: Toast["countdown"]): void {
  useApp.setState((s) => ({
    toasts: s.toasts.map((t) => (t.id === id ? { ...t, countdown } : t)),
  }));
}
