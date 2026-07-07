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

function indexOf(order: readonly number[], id: number | null): number {
  return id == null ? -1 : order.indexOf(id);
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
): SelectionState {
  const anchorIdx = indexOf(order, state.anchor);
  const targetIdx = indexOf(order, id);
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
): SelectionState {
  if (order.length === 0) return emptySelection();
  const leadIdx = indexOf(order, state.lead);
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
): SelectionState {
  if (order.length === 0) return emptySelection();
  const leadIdx = indexOf(order, state.lead);
  if (leadIdx === -1 || state.anchor == null) return arrowMove(state, order, dir);
  const nextIdx = Math.min(order.length - 1, Math.max(0, leadIdx + dir));
  return shiftRange(state, order, order[nextIdx]);
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
  existing: ReadonlySet<number>,
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
): number {
  if (prefix === "") return -1;
  const p = prefix.toLowerCase();
  let fallback = -1;
  for (let i = 0; i < names.length; i++) {
    const n = names[i].toLowerCase();
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
  const arr = [...selected];
  const last = arr.length > 0 ? arr[arr.length - 1] : null;
  return { selected, anchor: arr.length > 0 ? arr[0] : null, lead: last };
}
