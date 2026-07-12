/**
 * The ONE shared, cancellable hydration scheduler per listing — consumed by
 * both the viewport hook and the background trickle. Big listings (>5,000
 * entries) skip pass 2 server-side; every hydration flows through the
 * `hydrate_paths` patch API, which preserves row ids and icon tokens so
 * responses merge through the standard hydrate path.
 *
 * Concurrency contract (per listing): at most 1 viewport-priority request in
 * flight plus at most 1 low-priority background request; batches of ≤128; a
 * listing's queue drops on its change/navigation. With dual panes that is up
 * to 4 requests in flight — intended; `hydrate_paths` is stateless. Stale
 * responses are discarded by the listingId guard in the store's hydrate merge.
 */
import * as ipc from "./ipc";
import type { Entry } from "../types/ipc";
import type { PaneId } from "../stores/app";
import { usePanes } from "../stores/panes";

interface Item {
  id: number;
  path: string;
  icon: string;
}

interface HydratorState {
  paneId: PaneId;
  tabId: string;
  listingId: string;
  /** Rows still awaiting hydration (the scheduler's dedupe lives here). */
  itemsById: Map<number, Item>;
  viewportQueue: number[];
  viewportQueued: Set<number>;
  backgroundQueue: number[];
  viewportInFlight: boolean;
  backgroundInFlight: boolean;
}

const BATCH = 128;

const schedulers = new Map<string, HydratorState>();

/** Start (or replace) the scheduler for a listing whose pass 2 was skipped. */
export function initHydrator(
  paneId: PaneId,
  tabId: string,
  listingId: string,
  entries: readonly Entry[],
): void {
  const unhydrated = entries.filter((e) => !e.hydrated);
  if (unhydrated.length === 0) {
    schedulers.delete(listingId);
    return;
  }
  const state: HydratorState = {
    paneId,
    tabId,
    listingId,
    itemsById: new Map(
      unhydrated.map((e) => [e.id, { id: e.id, path: e.path, icon: e.icon }]),
    ),
    viewportQueue: [],
    viewportQueued: new Set(),
    backgroundQueue: unhydrated.map((e) => e.id),
    viewportInFlight: false,
    backgroundInFlight: false,
  };
  // Re-init replaces any previous scheduler for this listing; its in-flight
  // responses become no-ops via the identity checks in run().
  schedulers.set(listingId, state);
  pump(state);
}

/** Drop everything (navigation/listing change). No args = unconditional. */
export function dropHydrator(listingId?: string): void {
  if (listingId == null) schedulers.clear();
  else schedulers.delete(listingId);
}

/** Viewport rows preempt the background trickle. Already-hydrated or unknown
 *  ids are ignored (dedupe by id lives here, not in the hook). */
export function requestViewportHydration(listingId: string, ids: number[]): void {
  const c = schedulers.get(listingId);
  if (!c) return;
  for (const id of ids) {
    if (c.itemsById.has(id) && !c.viewportQueued.has(id)) {
      c.viewportQueued.add(id);
      c.viewportQueue.push(id);
    }
  }
  pump(c);
}

/** Test hook. No arg = pending rows across every listing's scheduler. */
export function hydratorPending(listingId?: string): number {
  if (listingId != null) return schedulers.get(listingId)?.itemsById.size ?? 0;
  let n = 0;
  for (const c of schedulers.values()) n += c.itemsById.size;
  return n;
}

function takeBatch(c: HydratorState, queue: number[]): Item[] {
  const items: Item[] = [];
  while (items.length < BATCH && queue.length > 0) {
    const id = queue.shift() as number;
    const item = c.itemsById.get(id);
    if (item) items.push(item);
  }
  return items;
}

function pump(c: HydratorState): void {
  if (!c.viewportInFlight && c.viewportQueue.length > 0) {
    const batch = takeBatch(c, c.viewportQueue);
    for (const b of batch) c.viewportQueued.delete(b.id);
    if (batch.length > 0) {
      c.viewportInFlight = true;
      void run(c, batch, "viewport");
    }
  }
  // Background trickles only while no viewport work is waiting (per listing).
  if (
    !c.backgroundInFlight &&
    c.viewportQueue.length === 0 &&
    c.backgroundQueue.length > 0
  ) {
    const batch = takeBatch(c, c.backgroundQueue);
    if (batch.length > 0) {
      c.backgroundInFlight = true;
      void run(c, batch, "background");
    }
  }
}

async function run(
  c: HydratorState,
  batch: Item[],
  lane: "viewport" | "background",
): Promise<void> {
  try {
    const entries = await ipc.hydratePaths(c.listingId, batch);
    if (schedulers.get(c.listingId) !== c) return; // listing changed mid-flight — discard
    for (const b of batch) c.itemsById.delete(b.id);
    const patches = entries.filter((e): e is Entry => e != null);
    if (patches.length > 0) {
      // Reuse the standard hydrate merge — same listingId staleness guard
      // the channel events use.
      usePanes
        .getState()
        .applyListEvent(c.paneId, c.tabId, c.listingId, { event: "hydrate", entries: patches });
    }
  } catch {
    // Backend unreachable — drop this scheduler; rows keep their pass-1 data.
    if (schedulers.get(c.listingId) === c) schedulers.delete(c.listingId);
    return;
  }
  if (schedulers.get(c.listingId) === c) {
    if (lane === "viewport") c.viewportInFlight = false;
    else c.backgroundInFlight = false;
    if (c.itemsById.size === 0) schedulers.delete(c.listingId);
    else pump(c);
  }
}
