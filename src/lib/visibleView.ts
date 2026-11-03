/**
 * Derived "visible rows" view of a tab, cached per entries array.
 *
 * Key presses, pointer events, footers and the views all need the visible
 * list (hidden + name filter applied) and often its ids / id→index map.
 * Recomputing those per event is O(n) at 100k entries, so one view is cached
 * per (entries array, filter, showHidden). Sort order is implied by the
 * entries array identity: every re-sort produces a new array.
 *
 * Hydration commits replace rows in place (same ids, same positions) in a
 * copied array; `noteEntriesPatched` records that so the next view is derived
 * from the previous one by patching the changed slots instead of refiltering,
 * and shares its ids / index / lowercased names.
 */
import type { Entry } from "../types/ipc";

export interface VisibleSource {
  entries: Entry[];
  filter: string;
  showHidden: boolean;
}

export class VisibleView {
  /** Rows in display order. Shared — never mutate. */
  readonly entries: Entry[];
  private ids_: number[] | null;
  private index_: Map<number, number> | null;
  private lower_: string[] | null;

  constructor(
    entries: Entry[],
    shared?: { ids: number[] | null; index: Map<number, number> | null; lower: string[] | null },
  ) {
    this.entries = entries;
    this.ids_ = shared?.ids ?? null;
    this.index_ = shared?.index ?? null;
    this.lower_ = shared?.lower ?? null;
  }

  /** Visible ids in display order (the selection model's `order`). */
  get ids(): number[] {
    if (this.ids_ == null) {
      const n = this.entries.length;
      const ids = new Array<number>(n);
      for (let i = 0; i < n; i++) ids[i] = this.entries[i].id;
      this.ids_ = ids;
    }
    return this.ids_;
  }

  /** id → visible index. */
  get indexById(): Map<number, number> {
    if (this.index_ == null) {
      const m = new Map<number, number>();
      const n = this.entries.length;
      for (let i = 0; i < n; i++) m.set(this.entries[i].id, i);
      this.index_ = m;
    }
    return this.index_;
  }

  /** Visible index of `id`, or -1. */
  indexOf(id: number | null | undefined): number {
    if (id == null) return -1;
    return this.indexById.get(id) ?? -1;
  }

  /** Lowercased names in display order (type-ahead). */
  get lowerNames(): string[] {
    if (this.lower_ == null) {
      const n = this.entries.length;
      const out = new Array<string>(n);
      for (let i = 0; i < n; i++) out[i] = this.entries[i].name.toLowerCase();
      this.lower_ = out;
    }
    return this.lower_;
  }

  /** @internal */
  sharedParts(): { ids: number[] | null; index: Map<number, number> | null; lower: string[] | null } {
    return { ids: this.ids_, index: this.index_, lower: this.lower_ };
  }
}

interface Slot {
  key: string;
  view: VisibleView;
}

/** Per entries array: the most recent views (one per filter/showHidden key). */
const cache = new WeakMap<readonly Entry[], Slot[]>();
const MAX_SLOTS = 2;

interface Patched {
  prev: readonly Entry[];
  indices: number[];
}
/** next entries array → how it was derived from the previous one. */
const patchedFrom = new WeakMap<readonly Entry[], Patched>();

function viewKey(filter: string, showHidden: boolean): string {
  return `${showHidden ? 1 : 0}\0${filter.trim().toLowerCase()}`;
}

function isVisible(e: Entry, q: string, showHidden: boolean): boolean {
  if (!showHidden && e.hidden) return false;
  if (q !== "" && !e.name.toLowerCase().includes(q)) return false;
  return true;
}

/**
 * Record that `next` is `prev` with the rows at `indices` replaced by
 * entries with the same ids (hydration patches). Only one generation is
 * kept, so no chain of old arrays stays alive.
 */
export function noteEntriesPatched(
  prev: readonly Entry[],
  next: readonly Entry[],
  indices: number[],
): void {
  patchedFrom.delete(prev);
  if (prev.length !== next.length) return;
  patchedFrom.set(next, { prev, indices });
}

function findSlot(entries: readonly Entry[], key: string): VisibleView | null {
  const slots = cache.get(entries);
  if (!slots) return null;
  for (const s of slots) if (s.key === key) return s.view;
  return null;
}

function store(entries: readonly Entry[], key: string, view: VisibleView): void {
  const slots = cache.get(entries) ?? [];
  slots.unshift({ key, view });
  if (slots.length > MAX_SLOTS) slots.length = MAX_SLOTS;
  cache.set(entries, slots);
}

function derive(
  next: readonly Entry[],
  key: string,
  q: string,
  showHidden: boolean,
): VisibleView | null {
  const info = patchedFrom.get(next);
  if (!info) return null;
  const prevView = findSlot(info.prev, key);
  if (!prevView) return null;
  const prev = info.prev;
  const identity = prevView.entries === prev; // no filtering applied
  const rows = identity ? (next as Entry[]) : prevView.entries.slice();
  let namesSame = true;
  for (const i of info.indices) {
    const before = prev[i];
    const after = next[i];
    if (!before || !after || before.id !== after.id) return null;
    const was = isVisible(before, q, showHidden);
    if (was !== isVisible(after, q, showHidden)) return null; // membership changed
    if (before.name !== after.name) namesSame = false;
    if (was && !identity) {
      const vi = prevView.indexOf(before.id);
      if (vi < 0) return null;
      rows[vi] = after;
    }
  }
  const parts = prevView.sharedParts();
  return new VisibleView(rows, {
    ids: parts.ids,
    index: parts.index,
    lower: namesSame ? parts.lower : null,
  });
}

/** The cached visible view of a tab. */
export function visibleView(tab: VisibleSource): VisibleView {
  const key = viewKey(tab.filter, tab.showHidden);
  const hit = findSlot(tab.entries, key);
  if (hit) return hit;
  const q = tab.filter.trim().toLowerCase();
  const view = derive(tab.entries, key, q, tab.showHidden) ?? filterView(tab.entries, q, tab.showHidden);
  patchedFrom.delete(tab.entries);
  store(tab.entries, key, view);
  return view;
}

function filterView(entries: Entry[], q: string, showHidden: boolean): VisibleView {
  if (showHidden && q === "") return new VisibleView(entries);
  const out: Entry[] = [];
  for (const e of entries) if (isVisible(e, q, showHidden)) out.push(e);
  return new VisibleView(out);
}
