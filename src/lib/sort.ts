/**
 * Natural sorting for directory entries. Pure — unit-tested.
 */
import type { Entry } from "../types/ipc";
import { kindLabel } from "./fileTypes";

export type SortKey = "name" | "size" | "mtime" | "kind";
export type SortDir = "asc" | "desc";

export interface SortSpec {
  key: SortKey;
  dir: SortDir;
}

/** Shared collator: natural ("file2" < "file10"), case/diacritic-insensitive. */
export const naturalCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

function isDirLike(e: Entry): boolean {
  // Packages sort with files (they behave as documents), plain dirs group first.
  return e.kind === "dir" && !e.isPackage;
}

export function entryKindLabel(e: Entry): string {
  return kindLabel({ kind: e.kind, ext: e.ext, isPackage: e.isPackage, isAlias: e.isAlias });
}

function compareBy(a: Entry, b: Entry, key: SortKey): number {
  switch (key) {
    case "name":
      return naturalCollator.compare(a.name, b.name);
    case "size": {
      // Unhydrated / dirs (null) sort after real sizes ascending.
      const sa = a.size;
      const sb = b.size;
      if (sa == null && sb == null) return 0;
      if (sa == null) return 1;
      if (sb == null) return -1;
      return sa - sb;
    }
    case "mtime": {
      const ma = a.mtime;
      const mb = b.mtime;
      if (ma == null && mb == null) return 0;
      if (ma == null) return 1;
      if (mb == null) return -1;
      return ma - mb;
    }
    case "kind":
      return naturalCollator.compare(entryKindLabel(a), entryKindLabel(b));
  }
}

/**
 * Sort entries by the spec. `dirsFirst` groups plain folders ahead of files
 * regardless of direction (Finder-style grouping). Name is the tiebreaker.
 * Returns a NEW array; does not mutate.
 */
export function sortEntries(entries: readonly Entry[], spec: SortSpec, dirsFirst = true): Entry[] {
  const sign = spec.dir === "asc" ? 1 : -1;
  const out = [...entries];
  out.sort((a, b) => {
    if (dirsFirst) {
      const da = isDirLike(a);
      const db = isDirLike(b);
      if (da !== db) return da ? -1 : 1;
    }
    const primary = compareBy(a, b, spec.key);
    if (primary !== 0) return sign * primary;
    if (spec.key !== "name") {
      const byName = naturalCollator.compare(a.name, b.name);
      if (byName !== 0) return byName;
    }
    return a.id - b.id; // stable, deterministic
  });
  return out;
}

/** Where a single entry should be inserted to keep sorted order (binary search). */
export function sortedInsertIndex(
  sorted: readonly Entry[],
  entry: Entry,
  spec: SortSpec,
  dirsFirst = true,
): number {
  const sign = spec.dir === "asc" ? 1 : -1;
  const cmp = (a: Entry, b: Entry): number => {
    if (dirsFirst) {
      const da = isDirLike(a);
      const db = isDirLike(b);
      if (da !== db) return da ? -1 : 1;
    }
    const primary = compareBy(a, b, spec.key);
    if (primary !== 0) return sign * primary;
    return naturalCollator.compare(a.name, b.name);
  };
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cmp(sorted[mid], entry) <= 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
