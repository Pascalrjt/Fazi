/**
 * Lazy folder sizes for list view (Settings → Advanced, default off).
 *
 * Session LRU keyed by path, computed via the streaming dir_size channel,
 * concurrency-capped at 2, viewport-triggered by the size cell. The value is
 * EXPLICITLY approximate: watchers are non-recursive, so nested external
 * edits are missed — each entry carries a 5-minute TTL after which it
 * recomputes on next viewport entry, and completed ops / watcher batches
 * invalidate every cached ancestor of a changed path.
 */
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import * as ipc from "../lib/ipc";
import { safeIpc } from "../lib/safeIpc";

const TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 512;
const MAX_CONCURRENT = 2;

interface DirSizeEntry {
  bytes: number | null;
  computing: boolean;
  /** Completion timestamp (TTL anchor); 0 while computing. */
  at: number;
}

interface DirSizesState {
  sizes: Record<string, DirSizeEntry>;

  /** Viewport-triggered: compute (or refresh past TTL) the size of `path`. */
  request(path: string): void;
  /** Drop every cached entry that is an ancestor of `changed` (or `changed`
   *  itself) — the cached dir contains the changed path. */
  invalidate(changedPaths: string[]): void;
  clear(): void;
}

let inFlight = 0;
const queue: string[] = [];
const queued = new Set<string>();
/** Insertion-ordered keys for the LRU cap. */
const order: string[] = [];

function isAncestorOrSelf(dir: string, changed: string): boolean {
  return changed === dir || changed.startsWith(`${dir}/`);
}

export const useDirSizes = create<DirSizesState>()(
  immer((set, get) => {
    function pump(): void {
      while (inFlight < MAX_CONCURRENT && queue.length > 0) {
        const path = queue.shift() as string;
        queued.delete(path);
        const entry = get().sizes[path];
        if (!entry || !entry.computing) continue; // invalidated while queued
        inFlight += 1;
        safeIpc(() =>
          ipc.dirSize(path, (e) => {
            set((s) => {
              const cur = s.sizes[path];
              if (!cur) return; // invalidated mid-stream
              cur.bytes = e.bytes;
              if (e.done) {
                cur.computing = false;
                cur.at = Date.now();
              }
            });
            if (e.done) {
              inFlight -= 1;
              pump();
            }
          }),
        ).catch(() => {
          set((s) => {
            delete s.sizes[path];
          });
          inFlight -= 1;
          pump();
        });
      }
    }

    return {
      sizes: {},

      request: (path) => {
        const existing = get().sizes[path];
        if (existing) {
          if (existing.computing) return;
          if (Date.now() - existing.at < TTL_MS) return; // fresh enough
        }
        if (queued.has(path)) return;
        set((s) => {
          // LRU cap — evict oldest completed entries.
          if (!(path in s.sizes)) {
            order.push(path);
            while (order.length > MAX_ENTRIES) {
              const evict = order.shift() as string;
              if (evict !== path) delete s.sizes[evict];
            }
          }
          s.sizes[path] = { bytes: existing?.bytes ?? null, computing: true, at: 0 };
        });
        queued.add(path);
        queue.push(path);
        pump();
      },

      invalidate: (changedPaths) => {
        if (changedPaths.length === 0) return;
        set((s) => {
          for (const dir of Object.keys(s.sizes)) {
            if (changedPaths.some((p) => isAncestorOrSelf(dir, p))) {
              delete s.sizes[dir];
              queued.delete(dir);
            }
          }
        });
      },

      clear: () => {
        queue.length = 0;
        queued.clear();
        order.length = 0;
        set((s) => {
          s.sizes = {};
        });
      },
    };
  }),
);
