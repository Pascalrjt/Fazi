import { describe, expect, it } from "vitest";
import {
  arrowMove,
  clearSelection,
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
  type ItemRect,
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

describe("selectAll / clear / prune", () => {
  it("selectAll selects every visible row", () => {
    const s = selectAll(order);
    expect(s.selected.size).toBe(5);
    expect(s.anchor).toBe(10);
    expect(s.lead).toBe(50);
  });

  it("clearSelection empties", () => {
    expect(clearSelection().selected.size).toBe(0);
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
  const items: ItemRect[] = [
    { id: 1, rect: { x: 0, y: 0, width: 100, height: 28 } },
    { id: 2, rect: { x: 0, y: 28, width: 100, height: 28 } },
    { id: 3, rect: { x: 0, y: 56, width: 100, height: 28 } },
    { id: 4, rect: { x: 0, y: 84, width: 100, height: 28 } },
  ];

  it("dragRect normalizes any drag direction", () => {
    expect(dragRect({ x: 50, y: 60 }, { x: 10, y: 20 })).toEqual({
      x: 10, y: 20, width: 40, height: 40,
    });
  });

  it("selects all intersecting items (including offscreen rows by rect math)", () => {
    const s = marqueeSelect({ x: 10, y: 30, width: 20, height: 40 }, items);
    expect([...s.selected].sort()).toEqual([2, 3]);
  });

  it("grazing a row's edge selects it; missing entirely does not", () => {
    const s = marqueeSelect({ x: 0, y: 27, width: 5, height: 2 }, items);
    expect([...s.selected].sort()).toEqual([1, 2]);
    const t = marqueeSelect({ x: 200, y: 0, width: 50, height: 200 }, items);
    expect(t.selected.size).toBe(0);
  });

  it("XOR-merges with a base selection (cmd-marquee)", () => {
    const s = marqueeSelect(
      { x: 0, y: 30, width: 100, height: 30 }, // hits 2,3
      items,
      new Set([1, 2]),
    );
    expect([...s.selected].sort()).toEqual([1, 3]);
  });
});
