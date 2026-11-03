/** Derived visible-view cache: hits, invalidation, incremental hydration. */
import { describe, expect, it } from "vitest";
import type { Entry } from "../../types/ipc";
import { noteEntriesPatched, visibleView } from "../visibleView";
import { IdQueue } from "../hydration";

function entry(id: number, name: string, extra: Partial<Entry> = {}): Entry {
  return {
    id,
    name,
    path: `/d/${name}`,
    kind: "file",
    hidden: name.startsWith("."),
    icon: "t",
    ext: "",
    hydrated: false,
    size: null,
    mtime: null,
    btime: null,
    isPackage: false,
    isAlias: false,
    linkTarget: null,
    tags: [],
    noAccess: false,
    customIcon: false,
    ...extra,
  };
}

const base = () => [entry(1, "Alpha"), entry(2, ".hidden"), entry(3, "beta"), entry(4, "Gamma")];

describe("visibleView cache", () => {
  it("caches per entries array + filter + showHidden", () => {
    const entries = base();
    const a = visibleView({ entries, filter: "", showHidden: false });
    expect(visibleView({ entries, filter: "", showHidden: false })).toBe(a);
    expect(a.entries.map((e) => e.id)).toEqual([1, 3, 4]);
    expect(a.ids).toEqual([1, 3, 4]);
    expect(a.indexOf(4)).toBe(2);
    expect(a.indexOf(2)).toBe(-1);
    expect(a.lowerNames).toEqual(["alpha", "beta", "gamma"]);

    // a different filter/showHidden is a different view
    const f = visibleView({ entries, filter: " A ", showHidden: false });
    expect(f).not.toBe(a);
    expect(f.ids).toEqual([1, 3, 4]); // "a" in alpha, beta, gamma
    const b = visibleView({ entries, filter: "be", showHidden: true });
    expect(b.ids).toEqual([3]);
    const all = visibleView({ entries, filter: "", showHidden: true });
    expect(all.entries).toBe(entries); // no copy when nothing is filtered
  });

  it("invalidates when the entries array changes (sort, watcher, rename)", () => {
    const entries = base();
    const a = visibleView({ entries, filter: "", showHidden: false });
    const resorted = [...entries].reverse();
    const b = visibleView({ entries: resorted, filter: "", showHidden: false });
    expect(b).not.toBe(a);
    expect(b.ids).toEqual([4, 3, 1]);
  });

  it("derives a hydration-patched array incrementally, sharing ids/index", () => {
    const entries = base();
    const a = visibleView({ entries, filter: "", showHidden: false });
    const index = a.indexById;
    const next = entries.slice();
    next[2] = { ...entries[2], hydrated: true, size: 42 };
    noteEntriesPatched(entries, next, [2]);
    const b = visibleView({ entries: next, filter: "", showHidden: false });
    expect(b).not.toBe(a);
    expect(b.entries[1]).toBe(next[2]);
    expect(b.entries[1].size).toBe(42);
    expect(b.indexById).toBe(index); // shared, not rebuilt
    expect(a.entries[1].size).toBeNull(); // old view untouched
  });

  it("falls back to a full refilter when a patch changes membership", () => {
    const entries = base();
    visibleView({ entries, filter: "", showHidden: false });
    const next = entries.slice();
    next[0] = { ...entries[0], hidden: true }; // hydration found UF_HIDDEN
    noteEntriesPatched(entries, next, [0]);
    const b = visibleView({ entries: next, filter: "", showHidden: false });
    expect(b.ids).toEqual([3, 4]);
  });

  it("does not share lowercased names when a patch renames", () => {
    const entries = base();
    const a = visibleView({ entries, filter: "", showHidden: true });
    void a.lowerNames;
    const next = entries.slice();
    next[3] = { ...entries[3], name: "Delta" };
    noteEntriesPatched(entries, next, [3]);
    const b = visibleView({ entries: next, filter: "", showHidden: true });
    expect(b.lowerNames[3]).toBe("delta");
  });
});

describe("IdQueue", () => {
  it("is FIFO across compaction", () => {
    const n = 10_000;
    const q = new IdQueue(Array.from({ length: n }, (_, i) => i));
    const out: number[] = [];
    for (let i = 0; i < 6_000; i++) out.push(q.shift() as number);
    q.push(n);
    while (q.size > 0) out.push(q.shift() as number);
    expect(out).toEqual(Array.from({ length: n + 1 }, (_, i) => i));
    expect(q.shift()).toBeUndefined();
  });
});
