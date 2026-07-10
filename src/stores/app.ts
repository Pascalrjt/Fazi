/** App-level UI state: active pane, palette, clipboard mirror, toasts, overlays. */
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { FuzzyFilters, SearchEvent } from "../types/ipc";
import * as ipc from "../lib/ipc";
import { safeIpc } from "../lib/safeIpc";
import { parseSearchQuery } from "../lib/searchQuery";
import { useSettings } from "./settings";

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
    ipc.fuzzyWarm(scopePath, settings.fuzzyExcludes, settings.fuzzyIndexMaxEntries),
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
  pushToast(message: string, opts?: { action?: Toast["action"]; danger?: boolean; sticky?: boolean }): void;
  dismissToast(id: number): void;
  setPreviewOpen(open: boolean): void;
  setGetInfoOpen(open: boolean): void;
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
const toastTimers = new Map<number, ReturnType<typeof setTimeout>>();

export const useApp = create<AppState>()(
  immer((set, get) => ({
    activePaneId: "left",
    paletteOpen: false,
    clipboard: null,
    toasts: [],
    previewOpen: false,
    getInfoOpen: false,
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
      set((s) => {
        s.toasts.push({ id, message, action: opts?.action, danger: opts?.danger });
        while (s.toasts.length > 3) {
          const evicted = s.toasts.shift();
          if (evicted) {
            const t = toastTimers.get(evicted.id);
            if (t) clearTimeout(t);
            toastTimers.delete(evicted.id);
          }
        }
      });
      if (!opts?.sticky) {
        toastTimers.set(
          id,
          setTimeout(() => get().dismissToast(id), 5000),
        );
      }
    },

    dismissToast: (id) => {
      const t = toastTimers.get(id);
      if (t) clearTimeout(t);
      toastTimers.delete(id);
      set((s) => {
        s.toasts = s.toasts.filter((toast) => toast.id !== id);
      });
    },

    setPreviewOpen: (open) => set({ previewOpen: open }),
    setGetInfoOpen: (open) => set({ getInfoOpen: open }),
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
