import { describe, expect, it } from "vitest";
import {
  calendarDaysBetween,
  countWithSize,
  expiryLabel,
  leavingPhrase,
  leavingSoon,
  ruleFolderName,
} from "../cleanup";
import type { CleanupItem } from "../../types/ipc";

// Local-time anchors so calendar math matches the user's day boundaries.
const at = (day: number, hour: number) => new Date(2026, 8, day, hour, 0, 0).getTime();
const NOW = at(28, 15); // 28 Sep, 3 pm

function item(over: Partial<CleanupItem>): CleanupItem {
  return {
    path: "/Users/me/Downloads/a.dmg",
    name: "a.dmg",
    dev: 1,
    ino: 1,
    isDir: false,
    size: 1000,
    added: at(10, 9),
    lastUsed: null,
    expires: at(29, 9),
    status: "scheduled",
    ...over,
  };
}

describe("expiryLabel", () => {
  it("names the next sweep, today, and tomorrow in red", () => {
    expect(expiryLabel(at(28, 10), NOW)).toEqual({ text: "Next sweep", tone: "due" });
    expect(expiryLabel(at(28, 23), NOW)).toEqual({ text: "Today", tone: "due" });
    expect(expiryLabel(at(29, 1), NOW)).toEqual({ text: "Tomorrow", tone: "due" });
  });

  it("counts calendar days, not 24-hour spans", () => {
    // 34 hours away but two calendar days out.
    expect(expiryLabel(at(30, 1), NOW)).toEqual({ text: "in 2 days", tone: "soon" });
    expect(expiryLabel(at(1 + 30, 9), NOW)).toEqual({ text: "in 3 days", tone: "soon" });
    expect(expiryLabel(at(2 + 30, 9), NOW)).toEqual({ text: "in 4 days", tone: "later" });
  });

  it("calendarDaysBetween is zero within a day", () => {
    expect(calendarDaysBetween(at(28, 0), at(28, 23))).toBe(0);
  });
});

describe("leavingSoon", () => {
  it("covers scheduled items due by the end of tomorrow", () => {
    expect(leavingSoon(item({ expires: at(29, 22) }), NOW)).toBe(true);
    expect(leavingSoon(item({ expires: at(30, 0) }), NOW)).toBe(false);
  });

  it("never flags kept, excluded, or in-progress items", () => {
    for (const status of ["kept", "excluded", "inProgress"] as const) {
      expect(leavingSoon(item({ status, expires: null }), NOW)).toBe(false);
    }
  });
});

describe("leavingPhrase", () => {
  it("picks today, tomorrow, or by tomorrow", () => {
    expect(leavingPhrase([item({ expires: at(28, 10) })], NOW)).toBe("today");
    expect(leavingPhrase([item({ expires: at(29, 10) })], NOW)).toBe("tomorrow");
    expect(
      leavingPhrase([item({ expires: at(28, 20) }), item({ expires: at(29, 10) })], NOW),
    ).toBe("by tomorrow");
  });
});

describe("countWithSize", () => {
  it("adds the total for files only", () => {
    expect(
      countWithSize([
        { size: 1_300_000_000, isDir: false },
        { size: 1_400_000_000, isDir: false },
      ]),
    ).toBe("2 items (2.7 GB)");
    // A folder's size isn't walked, so no (under-counted) total.
    expect(countWithSize([{ size: 10, isDir: false }, { size: null, isDir: true }])).toBe(
      "2 items",
    );
  });
});

describe("ruleFolderName", () => {
  it("uses the last path component", () => {
    expect(ruleFolderName("~/Downloads")).toBe("Downloads");
    expect(ruleFolderName("/Volumes/Disk/Inbox/")).toBe("Inbox");
    expect(ruleFolderName("~")).toBe("Home");
  });
});
