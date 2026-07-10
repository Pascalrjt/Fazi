/**
 * ⌘P fuzzy-finder state: overlay open/close, scope, streamed hits.
 *
 * Query lifecycle: each keystroke supersedes the previous query — the old
 * queryId is cancelled (which also revokes its icon tokens) and stale events
 * are dropped by queryId. The index is a snapshot of the walk moment; ops
 * completing under the root mark it stale so the next open rebuilds.
 */
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { FuzzyEvent, FuzzyItem } from "../types/ipc";
import * as ipc from "../lib/ipc";
import { safeIpc } from "../lib/safeIpc";
import { useSettings } from "./settings";
import { useVolumes } from "./volumes";
import { activePaneTab } from "./panes";

export type FuzzyScope = "folder" | "home";

const MAX_RESULTS = 100;

interface FuzzyState {
  open: boolean;
  scope: FuzzyScope;
  root: string | null;
  query: string;
  hits: FuzzyItem[];
  status: "idle" | "searching" | "done";
  indexed: number;
  indexing: boolean;
  capped: boolean;
  builtAtMs: number | null;
  queryId: string | null;
  /** A completed op touched paths under the root — rebuild on next open. */
  stale: boolean;
  error: string | null;

  openFinder(): void;
  close(): void;
  setScope(scope: FuzzyScope): void;
  setQuery(query: string): void;
  rebuild(): void;
  /** Called by the ops store on completion — invalidates a warm index. */
  markStaleIfUnder(paths: string[]): void;
}

function scopeRoot(scope: FuzzyScope): string | null {
  if (scope === "home") return useVolumes.getState().folders?.home ?? null;
  return activePaneTab()?.tab.path ?? null;
}

export const useFuzzy = create<FuzzyState>()(
  immer((set, get) => {
    function warm(root: string, force: boolean): void {
      const settings = useSettings.getState();
      safeIpc(() =>
        ipc.fuzzyWarm(root, settings.fuzzyExcludes, settings.fuzzyIndexMaxEntries, force),
      )
        .then((status) => {
          if (get().root !== root) return;
          set((s) => {
            s.indexed = status.indexed;
            s.indexing = status.indexing;
            s.capped = status.capped;
            s.builtAtMs = status.builtAtMs;
            s.stale = false;
          });
          runQuery(get().query);
        })
        .catch((err) => {
          if (get().root !== root) return;
          set((s) => {
            s.error = String(err);
            s.status = "done";
          });
        });
    }

    function runQuery(query: string): void {
      const { root, queryId: prev } = get();
      if (!root) return;
      if (prev) void ipc.fuzzyCancel(prev).catch(() => {});
      const queryId = crypto.randomUUID();
      set((s) => {
        s.queryId = queryId;
        s.status = "searching";
        s.error = null;
      });
      const onEvent = (e: FuzzyEvent) => {
        if (useFuzzy.getState().queryId !== queryId) return; // stale — dropped
        switch (e.event) {
          case "results":
            set((s) => {
              s.hits = e.items; // live batches replace, never append
              s.indexed = e.indexed;
              s.indexing = e.indexing;
            });
            break;
          case "done":
            set((s) => {
              s.status = "done";
              s.capped = e.capped;
              s.indexing = false;
            });
            break;
          default: {
            const _exhaustive: never = e;
            void _exhaustive;
          }
        }
      };
      safeIpc(() =>
        ipc.fuzzyQuery(
          { root, query, queryId, maxResults: MAX_RESULTS, live: true },
          onEvent,
        ),
      ).catch((err) => {
        if (useFuzzy.getState().queryId !== queryId) return;
        set((s) => {
          s.error = String(err);
          s.status = "done";
        });
      });
    }

    return {
      open: false,
      scope: "folder",
      root: null,
      query: "",
      hits: [],
      status: "idle",
      indexed: 0,
      indexing: false,
      capped: false,
      builtAtMs: null,
      queryId: null,
      stale: false,
      error: null,

      openFinder: () => {
        const scope = get().scope;
        const root = scopeRoot(scope);
        if (!root) return;
        const wasStale = get().stale;
        set((s) => {
          s.open = true;
          s.root = root;
          s.query = "";
          s.hits = [];
          s.status = "idle";
          s.error = null;
        });
        warm(root, wasStale);
      },

      close: () => {
        const { queryId } = get();
        if (queryId) void ipc.fuzzyCancel(queryId).catch(() => {}); // revokes tokens
        set((s) => {
          s.open = false;
          s.queryId = null;
          s.hits = [];
          s.query = "";
          s.status = "idle";
        });
      },

      setScope: (scope) => {
        const root = scopeRoot(scope);
        if (!root) return;
        const { queryId } = get();
        if (queryId) void ipc.fuzzyCancel(queryId).catch(() => {});
        set((s) => {
          s.scope = scope;
          s.root = root;
          s.hits = [];
          s.status = "idle";
          s.queryId = null;
        });
        warm(root, false);
      },

      setQuery: (query) => {
        set((s) => {
          s.query = query;
        });
        runQuery(query);
      },

      rebuild: () => {
        const { root } = get();
        if (!root) return;
        set((s) => {
          s.hits = [];
          s.status = "idle";
        });
        warm(root, true);
      },

      markStaleIfUnder: (paths) => {
        const { root } = get();
        if (!root || get().stale) return;
        const touched = paths.some(
          (p) => p === root || p.startsWith(`${root}/`),
        );
        if (touched) {
          set((s) => {
            s.stale = true;
          });
        }
      },
    };
  }),
);
