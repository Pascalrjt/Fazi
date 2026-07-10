/**
 * Pure tokenizer for search predicates:
 *   kind:image|video|audio|doc|pdf|folder|archive
 *   date:today|yesterday|7d|30d|<ISO>..<ISO>
 *   size:>10mb|<1gb|10mb..1gb
 * Recognized tokens become filters; everything else (including tokens with
 * unparseable values) stays in the residual text.
 */
import type { FuzzyFilters } from "../types/ipc";

export type SearchPredicates = FuzzyFilters;

const KINDS = new Set(["image", "video", "audio", "doc", "pdf", "folder", "archive"]);

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1024,
  mb: 1024 * 1024,
  gb: 1024 * 1024 * 1024,
  tb: 1024 * 1024 * 1024 * 1024,
};

function parseSize(raw: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(b|kb|mb|gb|tb)?$/i.exec(raw.trim());
  if (!m) return null;
  const unit = (m[2] ?? "b").toLowerCase();
  return Math.round(parseFloat(m[1]) * SIZE_UNITS[unit]);
}

function startOfDay(d: Date): number {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c.getTime();
}

/** Date-only ISO strings get end-of-day semantics on the "to" side. */
function parseIsoBound(raw: string, endOfDay: boolean): number | null {
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return null;
  const dateOnly = !raw.includes("T");
  return dateOnly && endOfDay ? t + 24 * 3600 * 1000 - 1 : t;
}

function applyDate(value: string, filters: SearchPredicates, now: Date): boolean {
  if (value === "today") {
    filters.dateFromMs = startOfDay(now);
    return true;
  }
  if (value === "yesterday") {
    const today = startOfDay(now);
    filters.dateFromMs = today - 24 * 3600 * 1000;
    filters.dateToMs = today - 1;
    return true;
  }
  const rel = /^(\d+)d$/.exec(value);
  if (rel) {
    filters.dateFromMs = now.getTime() - parseInt(rel[1], 10) * 24 * 3600 * 1000;
    return true;
  }
  const range = value.split("..");
  if (range.length === 2) {
    const from = parseIsoBound(range[0], false);
    const to = parseIsoBound(range[1], true);
    if (from == null || to == null) return false;
    filters.dateFromMs = from;
    filters.dateToMs = to;
    return true;
  }
  return false;
}

function applySize(value: string, filters: SearchPredicates): boolean {
  if (value.startsWith(">")) {
    const n = parseSize(value.slice(1));
    if (n == null) return false;
    filters.sizeMin = n;
    return true;
  }
  if (value.startsWith("<")) {
    const n = parseSize(value.slice(1));
    if (n == null) return false;
    filters.sizeMax = n;
    return true;
  }
  const range = value.split("..");
  if (range.length === 2) {
    const min = parseSize(range[0]);
    const max = parseSize(range[1]);
    if (min == null || max == null) return false;
    filters.sizeMin = min;
    filters.sizeMax = max;
    return true;
  }
  return false;
}

export function parseSearchQuery(
  raw: string,
  now: Date = new Date(),
): { text: string; filters: SearchPredicates; hasFilters: boolean } {
  const filters: SearchPredicates = {};
  const residual: string[] = [];
  for (const token of raw.split(/\s+/)) {
    if (token === "") continue;
    const sep = token.indexOf(":");
    if (sep > 0) {
      const key = token.slice(0, sep).toLowerCase();
      const value = token.slice(sep + 1);
      if (key === "kind" && KINDS.has(value.toLowerCase())) {
        filters.kind = value.toLowerCase();
        continue;
      }
      if (key === "date" && applyDate(value.toLowerCase(), filters, now)) {
        continue;
      }
      if (key === "size" && applySize(value.toLowerCase(), filters)) {
        continue;
      }
    }
    residual.push(token);
  }
  const hasFilters =
    filters.kind != null ||
    filters.dateFromMs != null ||
    filters.dateToMs != null ||
    filters.sizeMin != null ||
    filters.sizeMax != null;
  return { text: residual.join(" "), filters, hasFilters };
}
