/** Tokenizer tables for kind:/date:/size: predicates. */
import { describe, expect, it } from "vitest";
import { parseSearchQuery } from "../searchQuery";

const NOW = new Date("2026-07-11T15:30:00"); // local time
const DAY = 24 * 3600 * 1000;

describe("parseSearchQuery", () => {
  it("extracts kind and keeps residual text", () => {
    const r = parseSearchQuery("vacation kind:image beach");
    expect(r.text).toBe("vacation beach");
    expect(r.filters.kind).toBe("image");
    expect(r.hasFilters).toBe(true);
  });

  it("accepts every kind and rejects unknown kinds as text", () => {
    for (const k of ["image", "video", "audio", "doc", "pdf", "folder", "archive"]) {
      expect(parseSearchQuery(`kind:${k}`).filters.kind).toBe(k);
    }
    const r = parseSearchQuery("kind:weird");
    expect(r.filters.kind).toBeUndefined();
    expect(r.text).toBe("kind:weird");
  });

  it("date:today / yesterday / Nd relative arithmetic", () => {
    const today = new Date(NOW);
    today.setHours(0, 0, 0, 0);

    const t = parseSearchQuery("date:today", NOW);
    expect(t.filters.dateFromMs).toBe(today.getTime());
    expect(t.filters.dateToMs).toBeUndefined();

    const y = parseSearchQuery("date:yesterday", NOW);
    expect(y.filters.dateFromMs).toBe(today.getTime() - DAY);
    expect(y.filters.dateToMs).toBe(today.getTime() - 1);

    const week = parseSearchQuery("date:7d", NOW);
    expect(week.filters.dateFromMs).toBe(NOW.getTime() - 7 * DAY);
    const month = parseSearchQuery("date:30d", NOW);
    expect(month.filters.dateFromMs).toBe(NOW.getTime() - 30 * DAY);
  });

  it("date ISO range gets end-of-day semantics on the to side", () => {
    const r = parseSearchQuery("date:2026-01-01..2026-01-31", NOW);
    expect(r.filters.dateFromMs).toBe(Date.parse("2026-01-01"));
    expect(r.filters.dateToMs).toBe(Date.parse("2026-01-31") + DAY - 1);
  });

  it("size bounds: >, <, and ranges with units", () => {
    expect(parseSearchQuery("size:>10mb").filters.sizeMin).toBe(10 * 1024 * 1024);
    expect(parseSearchQuery("size:<1gb").filters.sizeMax).toBe(1024 ** 3);
    const range = parseSearchQuery("size:10mb..1gb").filters;
    expect(range.sizeMin).toBe(10 * 1024 * 1024);
    expect(range.sizeMax).toBe(1024 ** 3);
    // unitless = bytes
    expect(parseSearchQuery("size:>512").filters.sizeMin).toBe(512);
  });

  it("unparseable predicate values stay in the text", () => {
    const r = parseSearchQuery("size:huge date:someday report");
    expect(r.hasFilters).toBe(false);
    expect(r.text).toBe("size:huge date:someday report");
  });

  it("combines multiple predicates", () => {
    const r = parseSearchQuery("kind:pdf date:30d size:>1mb tax", NOW);
    expect(r.filters.kind).toBe("pdf");
    expect(r.filters.dateFromMs).toBe(NOW.getTime() - 30 * DAY);
    expect(r.filters.sizeMin).toBe(1024 * 1024);
    expect(r.text).toBe("tax");
  });
});
