/** The ASCII sort-key fast path must order exactly like the collator. */
import { describe, expect, it } from "vitest";
import type { Entry } from "../../types/ipc";
import {
  asciiFastPath,
  asciiSortKey,
  buildAsciiRank,
  compareNames,
  entryKindLabel,
  mergeSorted,
  naturalCollator,
  sortEntries,
  sortedInsertIndex,
  type SortSpec,
} from "../sort";

/** Deterministic PRNG so failures reproduce. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET =
  "aAbBcCzZ0123456789 ._-~!#$%&'()+,;=@[]^`{}0000119aAeE" +
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

function randomName(r: () => number): string {
  const len = 1 + Math.floor(r() * 12);
  let s = "";
  for (let i = 0; i < len; i++) {
    if (r() < 0.2) {
      // digit runs incl. leading zeros
      const zeros = Math.floor(r() * 3);
      s += "0".repeat(zeros) + String(Math.floor(r() * 10 ** (1 + Math.floor(r() * 6))));
    } else {
      s += ALPHABET[Math.floor(r() * ALPHABET.length)];
    }
  }
  return s;
}

const sign = (n: number) => (n < 0 ? -1 : n > 0 ? 1 : 0);

let seq = 0;
function entry(name: string, partial: Partial<Entry> = {}): Entry {
  return {
    id: ++seq,
    name,
    path: `/x/${name}`,
    kind: "file",
    hidden: false,
    icon: "t",
    ext: "",
    hydrated: true,
    size: null,
    mtime: null,
    btime: null,
    isPackage: false,
    isAlias: false,
    linkTarget: null,
    tags: [],
    noAccess: false,
    customIcon: false,
    ...partial,
  };
}

describe("ASCII sort-key fast path", () => {
  it("is active for the test locale", () => {
    expect(asciiFastPath).toBe(true);
  });

  it("agrees with Intl.Collator on random ASCII pairs (case, digits, punctuation)", () => {
    const r = rng(1234);
    for (let i = 0; i < 20_000; i++) {
      const a = randomName(r);
      // half the time: a near-variant of a (case flip, zero padding)
      const b =
        r() < 0.5
          ? randomName(r)
          : a.replace(/[a-z]/g, (c) => (r() < 0.5 ? c.toUpperCase() : c)).replace(/\d+/, (d) =>
              r() < 0.5 ? `0${d}` : d,
            );
      const ka = asciiSortKey(a);
      const kb = asciiSortKey(b);
      expect(ka).not.toBeNull();
      expect(kb).not.toBeNull();
      const fast = sign((ka as string) < (kb as string) ? -1 : ka! > kb! ? 1 : 0);
      const slow = sign(naturalCollator.compare(a, b));
      if (fast !== slow) throw new Error(`${JSON.stringify(a)} vs ${JSON.stringify(b)}: ${fast} != ${slow}`);
    }
  });

  it("known edge cases", () => {
    const cases: Array<[string, string]> = [
      ["file2", "file10"], ["01", "1"], ["a", "A"], ["a0", "a"], ["a00", "a0"], ["1.5", "1.10"],
      ["a b", "ab"], ["_x", "-x"], ["Z", "a"], ["9", "a"], ["a1b", "a01c"], ["", "0"],
    ];
    for (const [a, b] of cases) {
      expect(sign(compareNames(a, b))).toBe(sign(naturalCollator.compare(a, b)));
    }
  });

  it("falls back to the collator for non-ASCII names", () => {
    expect(asciiSortKey("café")).toBeNull();
    expect(asciiSortKey("tab\there")).toBeNull();
    expect(sign(compareNames("café", "cafe"))).toBe(sign(naturalCollator.compare("café", "cafe")));
    expect(sign(compareNames("Ärger", "Zebra"))).toBe(-1);
  });

  it("is disabled for locales with ASCII tailoring", () => {
    expect(buildAsciiRank(new Intl.Collator("cs", { numeric: true, sensitivity: "base" }))).toBeNull();
    expect(buildAsciiRank(new Intl.Collator("en", { numeric: false, sensitivity: "base" }))).toBeNull();
  });

  it("sortEntries matches a collator-only reference sort on mixed names", () => {
    const r = rng(99);
    const names = Array.from({ length: 3000 }, () =>
      r() < 0.1 ? `${randomName(r)}é` : randomName(r),
    );
    const entries = names.map((n, i) =>
      entry(n, {
        kind: r() < 0.2 ? "dir" : "file",
        size: r() < 0.3 ? null : Math.floor(r() * 50),
        mtime: r() < 0.3 ? null : Math.floor(r() * 50),
        ext: ["png", "txt", "", "md"][i % 4],
      }),
    );
    for (const spec of [
      { key: "name", dir: "asc" },
      { key: "name", dir: "desc" },
      { key: "size", dir: "asc" },
      { key: "mtime", dir: "desc" },
      { key: "kind", dir: "asc" },
    ] as SortSpec[]) {
      const ref = referenceSort(entries, spec);
      expect(sortEntries(entries, spec).map((e) => e.id)).toEqual(ref.map((e) => e.id));
    }
  });

  it("mergeSorted equals a full re-sort; sortedInsertIndex agrees", () => {
    const r = rng(7);
    const spec: SortSpec = { key: "name", dir: "asc" };
    const base = sortEntries(
      Array.from({ length: 500 }, () => entry(randomName(r), { kind: r() < 0.2 ? "dir" : "file" })),
      spec,
    );
    const adds = Array.from({ length: 40 }, () => entry(randomName(r), { kind: r() < 0.2 ? "dir" : "file" }));
    const merged = mergeSorted(base, adds, spec);
    expect(merged.map((e) => e.id)).toEqual(sortEntries([...base, ...adds], spec).map((e) => e.id));
    const one = adds[0];
    const at = sortedInsertIndex(base, one, spec);
    const withOne = [...base.slice(0, at), one, ...base.slice(at)];
    expect(withOne.map((e) => e.id)).toEqual(sortEntries([...base, one], spec).map((e) => e.id));
  });
});

/** The pre-fast-path implementation, verbatim in behaviour. */
function referenceSort(entries: readonly Entry[], spec: SortSpec): Entry[] {
  const s = spec.dir === "asc" ? 1 : -1;
  const dirLike = (e: Entry) => e.kind === "dir" && !e.isPackage;
  const nul = (a: number | null, b: number | null) =>
    a == null && b == null ? 0 : a == null ? 1 : b == null ? -1 : a - b;
  return [...entries].sort((a, b) => {
    const da = dirLike(a);
    const db = dirLike(b);
    if (da !== db) return da ? -1 : 1;
    let p: number;
    switch (spec.key) {
      case "name":
        p = naturalCollator.compare(a.name, b.name);
        break;
      case "size":
        p = nul(a.size, b.size);
        break;
      case "mtime":
        p = nul(a.mtime, b.mtime);
        break;
      case "kind":
        p = naturalCollator.compare(entryKindLabel(a), entryKindLabel(b));
        break;
    }
    if (p !== 0) return s * p;
    if (spec.key !== "name") {
      const n = naturalCollator.compare(a.name, b.name);
      if (n !== 0) return n;
    }
    return a.id - b.id;
  });
}
