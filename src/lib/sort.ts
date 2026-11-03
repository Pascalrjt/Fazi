/**
 * Natural sorting for directory entries. Pure — unit-tested.
 *
 * Performance: a 100k-entry sort makes ~1.7M comparisons. Going through
 * `Intl.Collator.compare` for each one dominates, so names are encoded once
 * per sort into a key whose plain code-unit order equals the collator's order
 * (decorate–sort–undecorate). The encoding covers printable-ASCII names and
 * is derived from (and checked against) the live collator; anything else
 * falls back to `naturalCollator.compare`.
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

// ---------------------------------------------------------------------------
// ASCII fast path
// ---------------------------------------------------------------------------

/**
 * Languages whose collation leaves printable ASCII on the CLDR root order (no
 * ASCII contractions or reorderings — unlike e.g. cs "ch", da "aa", or th's
 * default ignorePunctuation). Others always use the collator.
 */
const ROOT_ASCII_LANGS = new Set([
  "en", "fr", "de", "it", "pt", "nl", "ja", "zh", "ko", "ru", "uk", "el", "he", "ar", "id", "ms",
]);

/** ICU caps a numeric-collation digit run; longer runs take the slow path. */
const MAX_DIGIT_RUN = 200;

export interface AsciiRank {
  /** Per printable-ASCII code (0x20–0x7E): the code unit encoding its primary
   *  collation rank (case-folded); 0 for digits (handled as numbers). */
  table: Uint16Array;
  /** Code unit that starts a digit run in a key (the digits' rank). */
  digitMark: number;
}

/** Exported for tests: derive the rank table from a collator, or null. */
export function buildAsciiRank(collator: Intl.Collator): AsciiRank | null {
  const opts = collator.resolvedOptions();
  const lang = opts.locale.split("-")[0].toLowerCase();
  if (
    !ROOT_ASCII_LANGS.has(lang) ||
    !opts.numeric ||
    opts.ignorePunctuation ||
    opts.sensitivity !== "base" ||
    (opts.collation !== "default" && opts.collation !== "standard")
  ) {
    return null;
  }
  const chars: string[] = [];
  for (let c = 0x20; c <= 0x7e; c++) chars.push(String.fromCharCode(c));
  // No printable ASCII char may be ignorable (key encoding assumes weights).
  if (chars.some((ch) => collator.compare(ch, "") === 0)) return null;
  const sorted = [...chars].sort((a, b) => collator.compare(a, b));
  const table = new Uint16Array(0x7f);
  let rank = 1;
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && collator.compare(sorted[i - 1], sorted[i]) !== 0) rank++;
    table[sorted[i].charCodeAt(0)] = rank + 1; // ≥ 2: 1 is reserved below
  }
  // Digits must be contiguous ranks with nothing in between: a digit run is
  // then one token at the rank of "0", ordered by value.
  const r0 = table[0x30];
  for (let d = 0; d <= 9; d++) if (table[0x30 + d] !== r0 + d) return null;
  for (let c = 0x20; c <= 0x7e; c++) {
    if (c >= 0x30 && c <= 0x39) continue;
    if (table[c] >= r0 && table[c] <= r0 + 9) return null;
  }
  for (let d = 0; d <= 9; d++) table[0x30 + d] = 0;
  return { table, digitMark: r0 };
}

/** Null when the fast path is unavailable for this collator. */
const asciiRank: AsciiRank | null = buildAsciiRank(naturalCollator);

/** True when printable-ASCII names sort through the fast key path. */
export const asciiFastPath = asciiRank != null;

/**
 * Encode `s` into a key whose code-unit order (`<`) matches
 * `naturalCollator.compare` and whose equality matches compare() === 0.
 * Null for names outside printable ASCII (or a too-long digit run).
 *
 * Layout: each non-digit char → its rank; each digit run → digitMark,
 * (1 + significant-digit count), then the significant digits (leading zeros
 * are ignored by ICU numeric collation, as "01" == "1").
 */
export function asciiSortKey(s: string): string | null {
  if (asciiRank == null) return null;
  const { table, digitMark } = asciiRank;
  const n = s.length;
  let out = "";
  let i = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return null;
    if (c >= 0x30 && c <= 0x39) {
      let j = i;
      while (j < n && s.charCodeAt(j) === 0x30) j++;
      const start = j;
      while (j < n) {
        const d = s.charCodeAt(j);
        if (d < 0x30 || d > 0x39) break;
        j++;
      }
      if (j - i > MAX_DIGIT_RUN) return null;
      out += String.fromCharCode(digitMark, 1 + (j - start)) + s.slice(start, j);
      i = j;
    } else {
      out += String.fromCharCode(table[c]);
      i++;
    }
  }
  return out;
}

// Keys are recomputed per sort on purpose: caching them per Entry in a
// WeakMap costs more (WeakMap.set on 100k objects) than encoding again.

const labelKeys = new Map<string, string | null>();
function labelKeyOf(label: string): string | null {
  let k = labelKeys.get(label);
  if (k === undefined) {
    k = asciiSortKey(label);
    labelKeys.set(label, k);
  }
  return k;
}

function compareKeyed(ka: string | null, kb: string | null, a: string, b: string): number {
  if (ka != null && kb != null) return ka < kb ? -1 : ka > kb ? 1 : 0;
  return naturalCollator.compare(a, b);
}

/** Natural name comparison (collator-equivalent), using the fast path when possible. */
export function compareNames(a: string, b: string): number {
  return compareKeyed(asciiSortKey(a), asciiSortKey(b), a, b);
}

// ---------------------------------------------------------------------------
// entry comparison
// ---------------------------------------------------------------------------

function isDirLike(e: Entry): boolean {
  // Packages sort with files (they behave as documents), plain dirs group first.
  return e.kind === "dir" && !e.isPackage;
}

export function entryKindLabel(e: Entry): string {
  return kindLabel({ kind: e.kind, ext: e.ext, isPackage: e.isPackage, isAlias: e.isAlias });
}

function compareNullableNumber(a: number | null, b: number | null): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a - b;
}

/** A decorated entry: the sort keys computed once per sort. */
interface Decorated {
  e: Entry;
  dir: boolean;
  name: string | null;
  label: string;
  labelKey: string | null;
}

function decorate(e: Entry, key: SortKey): Decorated {
  const label = key === "kind" ? entryKindLabel(e) : "";
  return {
    e,
    dir: isDirLike(e),
    name: asciiSortKey(e.name),
    label,
    labelKey: key === "kind" ? labelKeyOf(label) : null,
  };
}

function decoratedComparator(
  spec: SortSpec,
  dirsFirst: boolean,
): (a: Decorated, b: Decorated) => number {
  const sign = spec.dir === "asc" ? 1 : -1;
  const key = spec.key;
  if (key === "name") {
    // Hot path (default sort): specialised, no per-call switch.
    return (a, b) => {
      if (dirsFirst && a.dir !== b.dir) return a.dir ? -1 : 1;
      const ka = a.name;
      const kb = b.name;
      if (ka !== null && kb !== null) {
        if (ka < kb) return -sign;
        if (ka > kb) return sign;
      } else {
        const p = naturalCollator.compare(a.e.name, b.e.name);
        if (p !== 0) return sign * p;
      }
      return a.e.id - b.e.id;
    };
  }
  return (a, b) => {
    if (dirsFirst && a.dir !== b.dir) return a.dir ? -1 : 1;
    let primary: number;
    switch (key) {
      case "size":
        // Unhydrated / dirs (null) sort after real sizes ascending.
        primary = compareNullableNumber(a.e.size, b.e.size);
        break;
      case "mtime":
        primary = compareNullableNumber(a.e.mtime, b.e.mtime);
        break;
      case "kind":
        primary = compareKeyed(a.labelKey, b.labelKey, a.label, b.label);
        break;
    }
    if (primary !== 0) return sign * primary;
    // name is the (unsigned) tiebreaker
    const byName = compareKeyed(a.name, b.name, a.e.name, b.e.name);
    if (byName !== 0) return byName;
    return a.e.id - b.e.id; // stable, deterministic
  };
}

/**
 * Sort entries by the spec. `dirsFirst` groups plain folders ahead of files
 * regardless of direction (Finder-style grouping). Name is the tiebreaker.
 * Returns a NEW array; does not mutate.
 */
export function sortEntries(entries: readonly Entry[], spec: SortSpec, dirsFirst = true): Entry[] {
  const n = entries.length;
  const dec = new Array<Decorated>(n);
  for (let i = 0; i < n; i++) dec[i] = decorate(entries[i], spec.key);
  dec.sort(decoratedComparator(spec, dirsFirst));
  const out = new Array<Entry>(n);
  for (let i = 0; i < n; i++) out[i] = dec[i].e;
  return out;
}

/**
 * Where a single entry should be inserted to keep sorted order (binary
 * search) — consistent with `sortEntries`' total order.
 */
export function sortedInsertIndex(
  sorted: readonly Entry[],
  entry: Entry,
  spec: SortSpec,
  dirsFirst = true,
): number {
  const cmp = decoratedComparator(spec, dirsFirst);
  const target = decorate(entry, spec.key);
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cmp(decorate(sorted[mid], spec.key), target) <= 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Merge `additions` into an already-sorted array in one O(n + k log n) pass
 * (instead of push + full re-sort). Returns a NEW array.
 */
export function mergeSorted(
  sorted: readonly Entry[],
  additions: readonly Entry[],
  spec: SortSpec,
  dirsFirst = true,
): Entry[] {
  if (additions.length === 0) return sorted.slice();
  const adds = sortEntries(additions, spec, dirsFirst);
  const cmp = decoratedComparator(spec, dirsFirst);
  const out: Entry[] = [];
  let from = 0;
  for (const add of adds) {
    // Positions are non-decreasing because `adds` is sorted.
    let lo = from;
    let hi = sorted.length;
    const target = decorate(add, spec.key);
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cmp(decorate(sorted[mid], spec.key), target) <= 0) lo = mid + 1;
      else hi = mid;
    }
    for (let i = from; i < lo; i++) out.push(sorted[i]);
    out.push(add);
    from = lo;
  }
  for (let i = from; i < sorted.length; i++) out.push(sorted[i]);
  return out;
}
