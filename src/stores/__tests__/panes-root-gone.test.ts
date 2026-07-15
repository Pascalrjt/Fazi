/**
 * rootGone recovery: the tab must land on the nearest EXISTING ancestor —
 * after an eject the immediate parent may be gone too.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/ipc", () => ({
  statPath: () => Promise.resolve(null),
}));

import { nearestExistingAncestor } from "../panes";

function existsIn(existing: string[]): (p: string) => Promise<boolean> {
  return (p) => Promise.resolve(existing.includes(p));
}

describe("nearestExistingAncestor", () => {
  it("returns the immediate parent when it survives", async () => {
    const dest = await nearestExistingAncestor(
      "/Volumes/USB/deep/folder",
      existsIn(["/Volumes/USB/deep", "/Volumes/USB", "/Volumes"]),
    );
    expect(dest).toBe("/Volumes/USB/deep");
  });

  it("skips vanished intermediate dirs to the survivor", async () => {
    const dest = await nearestExistingAncestor(
      "/Volumes/USB/deep/folder",
      existsIn(["/Volumes"]),
    );
    expect(dest).toBe("/Volumes");
  });

  it("falls back to / when every ancestor is gone", async () => {
    expect(await nearestExistingAncestor("/Volumes/USB/deep/folder", existsIn([]))).toBe("/");
    expect(await nearestExistingAncestor("/x", existsIn([]))).toBe("/");
  });

  it("treats exists-check failures as missing", async () => {
    const dest = await nearestExistingAncestor("/a/b/c", (p) =>
      p === "/a" ? Promise.resolve(true) : Promise.reject(new Error("io")).catch(() => false),
    );
    expect(dest).toBe("/a");
  });
});
