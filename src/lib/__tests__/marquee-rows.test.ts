/** Arithmetic list marquee must match the rect-per-row reference exactly. */
import { describe, expect, it } from "vitest";
import { marqueeSelect, marqueeSelectRows, rowRangeInRect, type Rect } from "../selection";

function reference(rect: Rect, ids: number[], rowH: number, width: number, base: Set<number> | null) {
  const items = ids.map((id, i) => ({ id, rect: { x: 0, y: i * rowH, width, height: rowH } }));
  return marqueeSelect(rect, items, base);
}

describe("list marquee arithmetic", () => {
  it("range edges follow the strict-overlap rule", () => {
    expect(rowRangeInRect({ x: 0, y: 0, width: 10, height: 28 }, 10, 28, 500)).toEqual([0, 0]);
    expect(rowRangeInRect({ x: 0, y: 28, width: 10, height: 0 }, 10, 28, 500)).toBeNull();
    expect(rowRangeInRect({ x: 0, y: 27, width: 10, height: 2 }, 10, 28, 500)).toEqual([0, 1]);
    expect(rowRangeInRect({ x: 0, y: 1000, width: 10, height: 50 }, 10, 28, 500)).toBeNull();
    expect(rowRangeInRect({ x: 600, y: 0, width: 10, height: 50 }, 10, 28, 500)).toBeNull();
    expect(rowRangeInRect({ x: 0, y: 0, width: 10, height: 50 }, 0, 28, 500)).toBeNull();
  });

  it("matches marqueeSelect over random rects, counts and bases", () => {
    let seed = 42;
    const r = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let iter = 0; iter < 2000; iter++) {
      const rowH = r() < 0.5 ? 28 : 24;
      const n = Math.floor(r() * 60);
      const ids = Array.from({ length: n }, (_, i) => 1000 - i * 3);
      const width = 300 + Math.floor(r() * 200);
      const x = Math.floor(r() * 700) - 100;
      const y = Math.floor(r() * (n + 5) * rowH) - 20 + (r() < 0.3 ? 0.5 : 0);
      const rect: Rect = {
        x,
        y,
        width: Math.floor(r() * 300),
        height: r() < 0.1 ? 0 : Math.floor(r() * 10 * rowH),
      };
      const base = r() < 0.4 ? new Set(ids.filter(() => r() < 0.3)) : null;
      const got = marqueeSelectRows(rect, ids, rowH, width, base);
      const want = reference(rect, ids, rowH, width, base);
      expect([...got.selected]).toEqual([...want.selected]);
      expect(got.anchor).toBe(want.anchor);
      expect(got.lead).toBe(want.lead);
    }
  });
});
