/**
 * The ONE shared, cancellable hydration scheduler per listing — consumed by
 * both the viewport hook and the background trickle. Big listings (>5,000
 * entries) skip pass 2 server-side; every hydration flows through the
 * `hydrate_paths` patch API, which preserves row ids and icon tokens so
 * responses merge through the standard hydrate path.
 *
 * Concurrency contract (per listing): viewport work starts immediately and
 * background work waits until the first viewport request has had a chance to
 * arrive. At most one request per lane is in flight; background state commits
 * are coalesced so a 100k listing does not trigger hundreds of full React
 * updates. A listing's queue and timers drop on navigation.
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

/** FIFO of ids with a head index: `shift()` on a ~100k array is O(n) per
 *  call (and it was called per id). Consumed slots are compacted lazily. */
export class IdQueue {
  private items: number[];
  private head = 0;

  constructor(items: number[] = []) {
    this.items = items;
  }

  get size(): number {
    return this.items.length - this.head;
  }

  push(id: number): void {
    this.items.push(id);
  }

  shift(): number | undefined {
    if (this.head >= this.items.length) return undefined;
    const id = this.items[this.head++];
    if (this.head >= this.items.length) {
      this.items = [];
      this.head = 0;
    } else if (this.head >= 4096 && this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return id;
  }
}

interface HydratorState {
  paneId: PaneId;
  tabId: string;
  listingId: string;
  /** Rows still awaiting hydration (the scheduler's dedupe lives here). */
  itemsById: Map<number, Item>;
  viewportQueue: IdQueue;
  viewportQueued: Set<number>;
  backgroundQueue: IdQueue;
  viewportInFlight: boolean;
  backgroundInFlight: boolean;
  backgroundReady: boolean;
  backgroundTimer: ReturnType<typeof setTimeout> | null;
  pumpTimer: ReturnType<typeof setTimeout> | null;
  pendingPatches: Entry[];
  patchTimer: ReturnType<typeof setTimeout> | null;
  /** Pending once-per-frame flush for viewport patches. */
  frameHandle: number | null;
}

const BATCH = 128;
const BACKGROUND_DELAY_MS = 150;
const BACKGROUND_YIELD_MS = 16;
const PATCH_COMMIT_MS = 50;

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
    viewportQueue: new IdQueue(),
    viewportQueued: new Set(),
    backgroundQueue: new IdQueue(unhydrated.map((e) => e.id)),
    viewportInFlight: false,
    backgroundInFlight: false,
    backgroundReady: false,
    backgroundTimer: null,
    pumpTimer: null,
    pendingPatches: [],
    patchTimer: null,
    frameHandle: null,
  };
  // Re-init replaces any previous scheduler for this listing; its in-flight
  // responses become no-ops via the identity checks in run().
  cleanupScheduler(schedulers.get(listingId));
  schedulers.set(listingId, state);
  pump(state);
  state.backgroundTimer = setTimeout(() => {
    if (schedulers.get(listingId) !== state) return;
    state.backgroundTimer = null;
    state.backgroundReady = true;
    pump(state);
  }, BACKGROUND_DELAY_MS);
}

/** Drop everything (navigation/listing change). No args = unconditional. */
export function dropHydrator(listingId?: string): void {
  if (listingId == null) {
    for (const scheduler of schedulers.values()) cleanupScheduler(scheduler);
    schedulers.clear();
  } else {
    cleanupScheduler(schedulers.get(listingId));
    schedulers.delete(listingId);
  }
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

function takeBatch(c: HydratorState, queue: IdQueue): Item[] {
  const items: Item[] = [];
  while (items.length < BATCH && queue.size > 0) {
    const id = queue.shift() as number;
    const item = c.itemsById.get(id);
    if (item) items.push(item);
  }
  return items;
}

function cleanupScheduler(c: HydratorState | undefined): void {
  if (!c) return;
  if (c.backgroundTimer != null) clearTimeout(c.backgroundTimer);
  if (c.pumpTimer != null) clearTimeout(c.pumpTimer);
  if (c.patchTimer != null) clearTimeout(c.patchTimer);
  if (c.frameHandle != null) cancelFrame(c.frameHandle);
  c.backgroundTimer = null;
  c.pumpTimer = null;
  c.patchTimer = null;
  c.frameHandle = null;
}

function flushPatches(c: HydratorState): void {
  if (c.patchTimer != null) {
    clearTimeout(c.patchTimer);
    c.patchTimer = null;
  }
  if (c.frameHandle != null) {
    cancelFrame(c.frameHandle);
    c.frameHandle = null;
  }
  if (c.pendingPatches.length === 0 || schedulers.get(c.listingId) !== c) return;
  const patches = c.pendingPatches.splice(0);
  usePanes
    .getState()
    .applyListEvent(c.paneId, c.tabId, c.listingId, { event: "hydrate", entries: patches });
}

const requestFrame: (cb: () => void) => number =
  typeof requestAnimationFrame === "function"
    ? (cb) => requestAnimationFrame(cb)
    : (cb) => setTimeout(cb, 16) as unknown as number;
const cancelFrame: (h: number) => void =
  typeof cancelAnimationFrame === "function"
    ? (h) => cancelAnimationFrame(h)
    : (h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>);

function queuePatches(c: HydratorState, patches: Entry[], lane: "viewport" | "background"): void {
  if (patches.length === 0) return;
  c.pendingPatches.push(...patches);
  if (lane === "viewport") {
    // Every commit copies the listing array and invalidates the views'
    // memos: coalesce viewport responses (plus any pending background
    // patches) into one commit per frame — still before the next paint.
    if (c.frameHandle == null) {
      c.frameHandle = requestFrame(() => {
        c.frameHandle = null;
        flushPatches(c);
      });
    }
    return;
  }
  if (c.patchTimer == null) {
    c.patchTimer = setTimeout(() => flushPatches(c), PATCH_COMMIT_MS);
  }
}

function schedulePump(c: HydratorState): void {
  if (c.pumpTimer != null) return;
  c.pumpTimer = setTimeout(() => {
    c.pumpTimer = null;
    if (schedulers.get(c.listingId) === c) pump(c);
  }, BACKGROUND_YIELD_MS);
}

function pump(c: HydratorState): void {
  if (!c.viewportInFlight && c.viewportQueue.size > 0) {
    const batch = takeBatch(c, c.viewportQueue);
    for (const b of batch) c.viewportQueued.delete(b.id);
    if (batch.length > 0) {
      c.viewportInFlight = true;
      void run(c, batch, "viewport");
    }
  }
  // Background trickles only while no viewport work is waiting (per listing).
  if (
    c.backgroundReady &&
    !c.backgroundInFlight &&
    !c.viewportInFlight &&
    c.viewportQueue.size === 0 &&
    c.backgroundQueue.size > 0
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
    queuePatches(c, patches, lane);
  } catch {
    // Backend unreachable — drop this scheduler; rows keep their pass-1 data.
    if (schedulers.get(c.listingId) === c) {
      cleanupScheduler(c);
      schedulers.delete(c.listingId);
    }
    return;
  }
  if (schedulers.get(c.listingId) === c) {
    if (lane === "viewport") c.viewportInFlight = false;
    else c.backgroundInFlight = false;
    if (c.itemsById.size === 0) {
      flushPatches(c);
      usePanes.getState().finishHydration(c.paneId, c.tabId, c.listingId);
      cleanupScheduler(c);
      schedulers.delete(c.listingId);
    } else if (lane === "background") {
      schedulePump(c);
    } else {
      pump(c);
    }
  }
}
