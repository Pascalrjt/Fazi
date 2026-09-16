import { describe, expect, it } from "vitest";
import {
  CLEANUP_DAY as DAY,
  cleanupLabel,
  cleanupNear,
  cleanupTooltip,
  cleanupWarningMs,
  type CleanupItem,
} from "../downloadsCleanup";
const now = Date.UTC(2026, 8, 16);
const item = (deadline: number | null, keep = false): CleanupItem => ({
  path: "/Downloads/a",
  name: "a",
  identity: "1",
  size: 1,
  modified: now,
  added: now,
  deadline,
  keep,
});
describe("Downloads cleanup indicators", () => {
  it("scales warning to retention and caps it at seven days", () => {
    expect(cleanupWarningMs(1)).toBe(DAY * 0.2);
    expect(cleanupWarningMs(7)).toBe(7 * DAY * 0.2);
    expect(cleanupWarningMs(30)).toBe(6 * DAY);
    expect(cleanupWarningMs(90)).toBe(7 * DAY);
    expect(cleanupNear(item(now + 6 * DAY), 30, now)).toBe(true);
    expect(cleanupNear(item(now + 6 * DAY + 1), 30, now)).toBe(false);
  });
  it("uses precise countdowns and a pending state when a deadline has passed", () => {
    expect(cleanupLabel(item(now + 12 * DAY), now)).toBe("In 12 days");
    expect(cleanupLabel(item(now + 6 * 3_600_000), now)).toBe("In 6 hours");
    expect(cleanupLabel(item(now + 60_000), now)).toBe("In 1 minute");
    expect(cleanupLabel(item(now + 1), now)).toBe("In <1 minute");
    expect(cleanupLabel(item(now), now)).toBe("Pending cleanup");
    expect(cleanupLabel(item(now - DAY), now)).toBe("Pending cleanup");
  });
  it("kept files have no warning even when an old deadline exists", () => {
    expect(cleanupLabel(item(null, true), now)).toBe("Kept");
    expect(cleanupNear(item(now - DAY, true), 30, now)).toBe(false);
    expect(cleanupTooltip(item(null, true))).toContain("Exempt");
    expect(cleanupTooltip(item(now))).toContain("Trash");
  });
});
