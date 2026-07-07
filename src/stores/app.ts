/** App-level UI state: active pane, palette, clipboard mirror, toasts, overlays. */
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { SearchEvent } from "../types/ipc";
import * as ipc from "../lib/ipc";
import { safeIpc } from "../lib/safeIpc";

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
}

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
    globalSearch: {
      active: false,
      query: "",
      scope: "folder",
      contents: false,
      hits: [],
      status: "idle",
      total: null,
      error: null,
      searchId: null,
    },

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
      set((s) => {
        s.globalSearch.active = true;
        s.globalSearch.query = query;
        if (scope) s.globalSearch.scope = scope;
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
      const prev = get().globalSearch.searchId;
      if (prev) void ipc.cancelSearch(prev).catch(() => {});
      if (query.trim() === "") {
        set((s) => {
          s.globalSearch.hits = [];
          s.globalSearch.status = "idle";
          s.globalSearch.total = null;
          s.globalSearch.searchId = null;
        });
        return;
      }
      const searchId = crypto.randomUUID();
      set((s) => {
        s.globalSearch.searchId = searchId;
        s.globalSearch.status = "searching";
        s.globalSearch.hits = [];
        s.globalSearch.total = null;
        s.globalSearch.error = null;
      });
      const onEvent = (e: SearchEvent) => {
        if (useApp.getState().globalSearch.searchId !== searchId) return;
        switch (e.event) {
          case "hit":
            set((s) => {
              if (s.globalSearch.hits.length < 2000) {
                s.globalSearch.hits.push({
                  path: e.path,
                  name: e.name,
                  isDir: e.isDir,
                  icon: e.icon,
                });
              }
            });
            break;
          case "done":
            set((s) => {
              s.globalSearch.status = "done";
              s.globalSearch.total = e.total;
            });
            break;
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
          { searchId, query, scope: scopePath, contents: get().globalSearch.contents },
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
      const prev = get().globalSearch.searchId;
      if (prev) void ipc.cancelSearch(prev).catch(() => {});
      set((s) => {
        s.globalSearch = {
          active: false,
          query: "",
          scope: "folder",
          contents: false,
          hits: [],
          status: "idle",
          total: null,
          error: null,
          searchId: null,
        };
      });
    },
  })),
);

/** Convenience for commands. */
export function toast(message: string, opts?: Parameters<AppState["pushToast"]>[1]): void {
  useApp.getState().pushToast(message, opts);
}
