/**
 * Pure multi-selection model over a *visible, sorted* array of entry ids.
 * No store imports, no DOM — fully unit-tested.
 *
 * `order` is always the current visible order (after sort + filter).
 * `anchor` / `lead` are entry ids (stable across re-sorts), not indices.
 */

export interface SelectionState {
  selected: Set<number>;
  /** Range anchor (shift-click / shift-arrows extend from here). */
  anchor: number | null;
  /** The "cursor" row — keyboard nav moves this; scroll follows it. */
  lead: number | null;
}

export function emptySelection(): SelectionState {
  return { selected: new Set(), anchor: null, lead: null };
}

/** Optional id → index lookup for `order` (avoids an O(n) indexOf per call). */
export type OrderIndex = { get(id: number): number | undefined };

function indexOf(order: readonly number[], id: number | null, index?: OrderIndex): number {
  if (id == null) return -1;
  if (index) return index.get(id) ?? -1;
  return order.indexOf(id);
}

/** Plain click: replace selection with the clicked row. */
export function clickSelect(id: number): SelectionState {
  return { selected: new Set([id]), anchor: id, lead: id };
}

/** Cmd+click: toggle membership; anchor/lead follow the toggled row. */
export function cmdToggle(state: SelectionState, id: number): SelectionState {
  const selected = new Set(state.selected);
  if (selected.has(id)) {
    selected.delete(id);
    // lead falls back to any remaining selected row
    const nextLead = selected.size > 0 ? [...selected][selected.size - 1] : null;
    return {
      selected,
      anchor: state.anchor === id ? nextLead : state.anchor,
      lead: state.lead === id ? nextLead : state.lead,
    };
  }
  selected.add(id);
  return { selected, anchor: id, lead: id };
}

/** Shift+click: select the contiguous range anchor→id (replacing), keep anchor. */
export function shiftRange(
  state: SelectionState,
  order: readonly number[],
  id: number,
  index?: OrderIndex,
): SelectionState {
  const anchorIdx = indexOf(order, state.anchor, index);
  const targetIdx = indexOf(order, id, index);
  if (targetIdx === -1) return state;
  if (anchorIdx === -1) return clickSelect(id);
  const [lo, hi] = anchorIdx <= targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx];
  const selected = new Set<number>();
  for (let i = lo; i <= hi; i++) selected.add(order[i]);
  return { selected, anchor: state.anchor, lead: id };
}

/**
 * Arrow up/down: move the lead by `dir` (±1) and select just that row.
 * With no selection, arrow selects first (down) / last (up) row.
 */
export function arrowMove(
  state: SelectionState,
  order: readonly number[],
  dir: 1 | -1,
  index?: OrderIndex,
): SelectionState {
  if (order.length === 0) return emptySelection();
  const leadIdx = indexOf(order, state.lead, index);
  let next: number;
  if (leadIdx === -1) {
    next = dir === 1 ? 0 : order.length - 1;
  } else {
    next = Math.min(order.length - 1, Math.max(0, leadIdx + dir));
  }
  return clickSelect(order[next]);
}

/** Shift+arrow: extend/shrink the anchor range by moving the lead. */
export function shiftArrowExtend(
  state: SelectionState,
  order: readonly number[],
  dir: 1 | -1,
  index?: OrderIndex,
): SelectionState {
  if (order.length === 0) return emptySelection();
  const leadIdx = indexOf(order, state.lead, index);
  if (leadIdx === -1 || state.anchor == null) return arrowMove(state, order, dir, index);
  const nextIdx = Math.min(order.length - 1, Math.max(0, leadIdx + dir));
  return shiftRange(state, order, order[nextIdx], index);
}

export function selectAll(order: readonly number[]): SelectionState {
  if (order.length === 0) return emptySelection();
  return {
    selected: new Set(order),
    anchor: order[0],
    lead: order[order.length - 1],
  };
}

export function clearSelection(): SelectionState {
  return emptySelection();
}

/** Drop ids that no longer exist in the listing (watcher removals, filters do NOT prune). */
export function pruneSelection(
  state: SelectionState,
  existing: { has(id: number): boolean },
): SelectionState {
  let changed = false;
  const selected = new Set<number>();
  for (const id of state.selected) {
    if (existing.has(id)) selected.add(id);
    else changed = true;
  }
  const anchor = state.anchor != null && existing.has(state.anchor) ? state.anchor : null;
  const lead = state.lead != null && existing.has(state.lead) ? state.lead : null;
  if (!changed && anchor === state.anchor && lead === state.lead) return state;
  return { selected, anchor, lead };
}

// ---------------------------------------------------------------------------
// Type-ahead
// ---------------------------------------------------------------------------

export const TYPE_AHEAD_DECAY_MS = 700;

export interface TypeAheadState {
  buffer: string;
  lastKeyAt: number;
}

export function emptyTypeAhead(): TypeAheadState {
  return { buffer: "", lastKeyAt: 0 };
}

/** Feed one printable char; returns the new buffer state (decays after 700ms). */
export function typeAheadPush(state: TypeAheadState, char: string, now: number): TypeAheadState {
  const buffer = now - state.lastKeyAt > TYPE_AHEAD_DECAY_MS ? char : state.buffer + char;
  return { buffer: buffer.toLowerCase(), lastKeyAt: now };
}

/**
 * Find the row to jump to for the current prefix buffer: first name (in visible
 * order) starting with the prefix; falls back to first name ≥ prefix; -1 if none.
 */
export function typeAheadTarget(
  names: readonly string[],
  prefix: string,
  /** `names` are already lowercased (e.g. VisibleView.lowerNames). */
  lowered = false,
): number {
  if (prefix === "") return -1;
  const p = prefix.toLowerCase();
  let fallback = -1;
  for (let i = 0; i < names.length; i++) {
    const n = lowered ? names[i] : names[i].toLowerCase();
    if (n.startsWith(p)) return i;
    if (fallback === -1 && n > p) fallback = i;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Marquee
// ---------------------------------------------------------------------------

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ItemRect {
  id: number;
  rect: Rect;
}

function intersects(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/** Normalize a drag from `start` to `current` into a positive rect. */
export function dragRect(start: { x: number; y: number }, current: { x: number; y: number }): Rect {
  return {
    x: Math.min(start.x, current.x),
    y: Math.min(start.y, current.y),
    width: Math.abs(current.x - start.x),
    height: Math.abs(current.y - start.y),
  };
}

/**
 * Marquee selection: every item whose rect intersects the marquee.
 * `base` (cmd/shift-marquee) is XOR-merged so a marquee can extend an
 * existing selection; pass null for a plain replace-marquee.
 */
export function marqueeSelect(
  rect: Rect,
  items: readonly ItemRect[],
  base: ReadonlySet<number> | null = null,
): SelectionState {
  const hit = new Set<number>();
  for (const item of items) {
    if (intersects(rect, item.rect)) hit.add(item.id);
  }
  return marqueeFromHits(hit, base);
}

/**
 * Fixed-height rows spanning `[0, width)` horizontally, row i at
 * `[i * rowH, (i + 1) * rowH)`: the inclusive index range `[lo, hi]` the
 * marquee intersects (same strict-overlap rule as `marqueeSelect`), or null.
 * O(1) instead of one rect per row.
 */
export function rowRangeInRect(
  rect: Rect,
  count: number,
  rowH: number,
  width: number,
): [number, number] | null {
  if (count <= 0 || rowH <= 0) return null;
  if (!(rect.x < width && rect.x + rect.width > 0)) return null;
  // row i overlaps iff  i*rowH < y+h  &&  (i+1)*rowH > y
  const lo = Math.max(0, Math.floor(rect.y / rowH));
  const hi = Math.min(count - 1, Math.ceil((rect.y + rect.height) / rowH) - 1);
  return lo <= hi ? [lo, hi] : null;
}

/** Marquee over fixed-height list rows: hits found by arithmetic, in display order. */
export function marqueeSelectRows(
  rect: Rect,
  ids: readonly number[],
  rowH: number,
  width: number,
  base: ReadonlySet<number> | null = null,
): SelectionState {
  const hit = new Set<number>();
  const range = rowRangeInRect(rect, ids.length, rowH, width);
  if (range) for (let i = range[0]; i <= range[1]; i++) hit.add(ids[i]);
  return marqueeFromHits(hit, base);
}

function marqueeFromHits(hit: Set<number>, base: ReadonlySet<number> | null): SelectionState {
  let selected: Set<number>;
  if (base) {
    selected = new Set(base);
    for (const id of hit) {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
    }
  } else {
    selected = hit;
  }
  let first: number | null = null;
  let last: number | null = null;
  for (const id of selected) {
    if (first === null) first = id;
    last = id;
  }
  return { selected, anchor: first, lead: last };
}
