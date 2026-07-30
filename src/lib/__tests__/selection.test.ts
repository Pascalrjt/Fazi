import { describe, expect, it } from "vitest";
import {
  arrowMove,
  clickSelect,
  cmdToggle,
  dragRect,
  emptySelection,
  emptyTypeAhead,
  marqueeSelect,
  pruneSelection,
  selectAll,
  shiftArrowExtend,
  shiftRange,
  typeAheadPush,
  typeAheadTarget,
  type SelectionState,
} from "../selection";

const order = [10, 20, 30, 40, 50];

function sel(ids: number[], anchor: number | null, lead: number | null): SelectionState {
  return { selected: new Set(ids), anchor, lead };
}

describe("clickSelect", () => {
  it("replaces the selection with the clicked row", () => {
    const s = clickSelect(30);
    expect([...s.selected]).toEqual([30]);
    expect(s.anchor).toBe(30);
    expect(s.lead).toBe(30);
  });
});

describe("cmdToggle", () => {
  it("adds an unselected row and moves anchor+lead", () => {
    const s = cmdToggle(clickSelect(10), 30);
    expect([...s.selected].sort()).toEqual([10, 30]);
    expect(s.anchor).toBe(30);
    expect(s.lead).toBe(30);
  });

  it("removes a selected row", () => {
    const s = cmdToggle(sel([10, 30], 10, 30), 30);
    expect([...s.selected]).toEqual([10]);
    expect(s.lead).toBe(10);
  });

  it("toggling the only selected row empties the selection", () => {
    const s = cmdToggle(clickSelect(20), 20);
    expect(s.selected.size).toBe(0);
    expect(s.anchor).toBeNull();
    expect(s.lead).toBeNull();
  });
});

describe("shiftRange", () => {
  it("selects anchor→target inclusive, keeps anchor, moves lead", () => {
    const s = shiftRange(clickSelect(20), order, 40);
    expect([...s.selected].sort((a, b) => a - b)).toEqual([20, 30, 40]);
    expect(s.anchor).toBe(20);
    expect(s.lead).toBe(40);
  });

  it("works upward (target before anchor)", () => {
    const s = shiftRange(clickSelect(40), order, 10);
    expect([...s.selected].sort((a, b) => a - b)).toEqual([10, 20, 30, 40]);
    expect(s.anchor).toBe(40);
  });

  it("re-shifting replaces the previous range (Finder semantics)", () => {
    let s = shiftRange(clickSelect(20), order, 50);
    s = shiftRange(s, order, 30);
    expect([...s.selected].sort((a, b) => a - b)).toEqual([20, 30]);
  });

  it("falls back to clickSelect with no anchor", () => {
    const s = shiftRange(emptySelection(), order, 30);
    expect([...s.selected]).toEqual([30]);
  });

  it("ignores targets not in the visible order", () => {
    const before = clickSelect(20);
    expect(shiftRange(before, order, 999)).toBe(before);
  });
});

describe("arrowMove", () => {
  it("moves the lead down and collapses selection to it", () => {
    const s = arrowMove(sel([20, 30], 20, 30), order, 1);
    expect([...s.selected]).toEqual([40]);
    expect(s.lead).toBe(40);
  });

  it("clamps at the ends", () => {
    const s = arrowMove(clickSelect(50), order, 1);
    expect(s.lead).toBe(50);
    const t = arrowMove(clickSelect(10), order, -1);
    expect(t.lead).toBe(10);
  });

  it("selects first row on down with empty selection", () => {
    expect(arrowMove(emptySelection(), order, 1).lead).toBe(10);
  });

  it("selects last row on up with empty selection", () => {
    expect(arrowMove(emptySelection(), order, -1).lead).toBe(50);
  });

  it("handles empty order", () => {
    expect(arrowMove(emptySelection(), [], 1).selected.size).toBe(0);
  });
});

describe("shiftArrowExtend", () => {
  it("extends downward from the anchor", () => {
    let s = clickSelect(20);
    s = shiftArrowExtend(s, order, 1);
    s = shiftArrowExtend(s, order, 1);
    expect([...s.selected].sort((a, b) => a - b)).toEqual([20, 30, 40]);
    expect(s.anchor).toBe(20);
    expect(s.lead).toBe(40);
  });

  it("shrinks when moving back toward the anchor", () => {
    let s = clickSelect(20);
    s = shiftArrowExtend(s, order, 1); // 20,30
    s = shiftArrowExtend(s, order, 1); // 20,30,40
    s = shiftArrowExtend(s, order, -1); // 20,30
    expect([...s.selected].sort((a, b) => a - b)).toEqual([20, 30]);
    expect(s.lead).toBe(30);
  });

  it("crosses the anchor cleanly", () => {
    let s = clickSelect(30);
    s = shiftArrowExtend(s, order, -1); // 20,30
    s = shiftArrowExtend(s, order, -1); // 10,20,30
    expect([...s.selected].sort((a, b) => a - b)).toEqual([10, 20, 30]);
    expect(s.anchor).toBe(30);
    expect(s.lead).toBe(10);
  });

  it("clamps at the last row", () => {
    let s = clickSelect(40);
    s = shiftArrowExtend(s, order, 1);
    s = shiftArrowExtend(s, order, 1); // clamped
    expect([...s.selected].sort((a, b) => a - b)).toEqual([40, 50]);
  });
});

describe("stride (moveLead single-clamp)", () => {
  // 9 rows so grid strides (columns=3) and boundary clamps are distinguishable.
  const grid = [10, 20, 30, 40, 50, 60, 70, 80, 90];

  /** The pre-optimization moveLead loop: one single-step call per stride. */
  function loopMove(
    state: SelectionState,
    ord: readonly number[],
    dir: 1 | -1,
    extend: boolean,
    stride: number,
  ): SelectionState {
    let s = state;
    for (let i = 0; i < stride; i++) {
      s = extend ? shiftArrowExtend(s, ord, dir) : arrowMove(s, ord, dir);
    }
    return s;
  }

  interface Case {
    name: string;
    state: SelectionState;
    dir: 1 | -1;
    extend: boolean;
    stride: number;
    selected: number[];
    anchor: number | null;
    lead: number | null;
  }

  const table: Case[] = [
    // direction × empty selection, non-extend
    { name: "down, empty, stride 1 selects first row", state: emptySelection(), dir: 1, extend: false, stride: 1, selected: [10], anchor: 10, lead: 10 },
    { name: "up, empty, stride 1 selects last row", state: emptySelection(), dir: -1, extend: false, stride: 1, selected: [90], anchor: 90, lead: 90 },
    // grid stride >1: first step establishes the lead, the rest apply
    { name: "down, empty, grid stride 3 lands on row 3", state: emptySelection(), dir: 1, extend: false, stride: 3, selected: [30], anchor: 30, lead: 30 },
    { name: "up, empty, grid stride 3 lands 2 above last", state: emptySelection(), dir: -1, extend: false, stride: 3, selected: [70], anchor: 70, lead: 70 },
    // direction × existing selection, non-extend
    { name: "down, lead 50, grid stride 3", state: clickSelect(50), dir: 1, extend: false, stride: 3, selected: [80], anchor: 80, lead: 80 },
    { name: "up, lead 50, grid stride 3", state: clickSelect(50), dir: -1, extend: false, stride: 3, selected: [20], anchor: 20, lead: 20 },
    // large count clamping at both boundaries
    { name: "down, lead 50, count 999 clamps to last", state: clickSelect(50), dir: 1, extend: false, stride: 999, selected: [90], anchor: 90, lead: 90 },
    { name: "up, lead 50, count 999 clamps to first", state: clickSelect(50), dir: -1, extend: false, stride: 999, selected: [10], anchor: 10, lead: 10 },
    { name: "down, empty, count 999 clamps to last", state: emptySelection(), dir: 1, extend: false, stride: 999, selected: [90], anchor: 90, lead: 90 },
    { name: "up, empty, count 999 clamps to first", state: emptySelection(), dir: -1, extend: false, stride: 999, selected: [10], anchor: 10, lead: 10 },
    { name: "down, lead at last row, stride 3 stays put", state: clickSelect(90), dir: 1, extend: false, stride: 3, selected: [90], anchor: 90, lead: 90 },
    // extend × empty selection: first step establishes the anchor
    { name: "down, empty, extend grid stride 3 anchors at first row", state: emptySelection(), dir: 1, extend: true, stride: 3, selected: [10, 20, 30], anchor: 10, lead: 30 },
    { name: "up, empty, extend grid stride 3 anchors at last row", state: emptySelection(), dir: -1, extend: true, stride: 3, selected: [70, 80, 90], anchor: 90, lead: 70 },
    // extend × existing selection
    { name: "down, lead 30, extend stride 1", state: clickSelect(30), dir: 1, extend: true, stride: 1, selected: [30, 40], anchor: 30, lead: 40 },
    { name: "up, lead 30, extend stride 1", state: clickSelect(30), dir: -1, extend: true, stride: 1, selected: [20, 30], anchor: 30, lead: 20 },
    { name: "down, lead 30, extend grid stride 3", state: clickSelect(30), dir: 1, extend: true, stride: 3, selected: [30, 40, 50, 60], anchor: 30, lead: 60 },
    { name: "up shrinks toward the anchor, grid stride 3", state: sel([50, 60, 70], 50, 70), dir: -1, extend: true, stride: 3, selected: [40, 50], anchor: 50, lead: 40 },
    // extend × large count clamping at both boundaries
    { name: "down, lead 30, extend count 999 clamps to last", state: clickSelect(30), dir: 1, extend: true, stride: 999, selected: [30, 40, 50, 60, 70, 80, 90], anchor: 30, lead: 90 },
    { name: "up, lead 30, extend count 999 clamps to first", state: clickSelect(30), dir: -1, extend: true, stride: 999, selected: [10, 20, 30], anchor: 30, lead: 10 },
    { name: "down at the last row, extend stride 3 keeps shape", state: sel([80, 90], 80, 90), dir: 1, extend: true, stride: 3, selected: [80, 90], anchor: 80, lead: 90 },
  ];

  for (const c of table) {
    it(c.name, () => {
      const got = c.extend
        ? shiftArrowExtend(c.state, grid, c.dir, c.stride)
        : arrowMove(c.state, grid, c.dir, c.stride);
      expect([...got.selected].sort((a, b) => a - b)).toEqual(c.selected);
      expect(got.anchor).toBe(c.anchor);
      expect(got.lead).toBe(c.lead);
      expect(got).toEqual(loopMove(c.state, grid, c.dir, c.extend, c.stride));
    });
  }

  it("handles an empty order at any stride", () => {
    expect(arrowMove(emptySelection(), [], 1, 5).selected.size).toBe(0);
    expect(shiftArrowExtend(emptySelection(), [], -1, 5).selected.size).toBe(0);
  });
});

describe("selectAll / prune", () => {
  it("selectAll selects every visible row", () => {
    const s = selectAll(order);
    expect(s.selected.size).toBe(5);
    expect(s.anchor).toBe(10);
    expect(s.lead).toBe(50);
  });

  it("prune drops vanished ids and resets dangling anchor/lead", () => {
    const s = pruneSelection(sel([10, 20, 30], 10, 30), new Set([20, 40]));
    expect([...s.selected]).toEqual([20]);
    expect(s.anchor).toBeNull();
    expect(s.lead).toBeNull();
  });

  it("prune returns the same object when nothing changed", () => {
    const before = sel([20], 20, 20);
    expect(pruneSelection(before, new Set(order))).toBe(before);
  });
});

describe("type-ahead", () => {
  const names = ["Applications", "Desktop", "Documents", "Downloads", "zebra.txt"];

  it("accumulates chars within the decay window", () => {
    let t = emptyTypeAhead();
    t = typeAheadPush(t, "d", 1000);
    t = typeAheadPush(t, "o", 1200);
    t = typeAheadPush(t, "w", 1400);
    expect(t.buffer).toBe("dow");
    expect(typeAheadTarget(names, t.buffer)).toBe(3);
  });

  it("resets the buffer after 700ms of silence", () => {
    let t = typeAheadPush(emptyTypeAhead(), "d", 1000);
    t = typeAheadPush(t, "z", 1000 + 701);
    expect(t.buffer).toBe("z");
    expect(typeAheadTarget(names, t.buffer)).toBe(4);
  });

  it("matches case-insensitively and jumps to first prefix match", () => {
    expect(typeAheadTarget(names, "de")).toBe(1);
    expect(typeAheadTarget(names, "DOCU")).toBe(2);
  });

  it("falls back to the first name greater than the prefix", () => {
    expect(typeAheadTarget(names, "c")).toBe(1); // no c* → Desktop
  });

  it("returns -1 for empty prefix and past-the-end prefixes", () => {
    expect(typeAheadTarget(names, "")).toBe(-1);
    expect(typeAheadTarget(names, "zzzz")).toBe(-1);
  });
});

describe("marquee", () => {
  // Rows [1, 2, 3, 4] laid out at 28px each: row i spans y ∈ [i·28, (i+1)·28).
  const rows = [1, 2, 3, 4];
  const ROW_H = 28;

  it("dragRect normalizes any drag direction", () => {
    expect(dragRect({ x: 50, y: 60 }, { x: 10, y: 20 })).toEqual({
      x: 10, y: 20, width: 40, height: 40,
    });
  });

  it("selects all covered rows (including offscreen rows by index math)", () => {
    const s = marqueeSelect({ x: 10, y: 30, width: 20, height: 40 }, rows, ROW_H);
    expect([...s.selected].sort()).toEqual([2, 3]);
  });

  it("grazing a row's edge selects it; missing entirely does not", () => {
    const s = marqueeSelect({ x: 0, y: 27, width: 5, height: 2 }, rows, ROW_H);
    expect([...s.selected].sort()).toEqual([1, 2]);
    // Ending exactly on a row boundary does not graze the next row.
    const u = marqueeSelect({ x: 0, y: 0, width: 5, height: 28 }, rows, ROW_H);
    expect([...u.selected].sort()).toEqual([1]);
    // Entirely below the last row: nothing.
    const t = marqueeSelect({ x: 0, y: 200, width: 50, height: 50 }, rows, ROW_H);
    expect(t.selected.size).toBe(0);
  });

  it("XOR-merges with a base selection (cmd-marquee)", () => {
    const s = marqueeSelect(
      { x: 0, y: 30, width: 100, height: 30 }, // hits 2,3
      rows,
      ROW_H,
      new Set([1, 2]),
    );
    expect([...s.selected].sort()).toEqual([1, 3]);
  });
});
