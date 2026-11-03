import { beforeEach, describe, expect, it } from "vitest";
import { _resetImageRevs, entryIconUrl, entryThumbUrl, imageRev } from "../imageRev";

const tok = "0123456789abcdef0123456789abcdef";

describe("image URL revisions", () => {
  beforeEach(() => _resetImageRevs());

  it("keeps the plain URL through hydration, changes it after an edit", () => {
    const unhydrated = { icon: tok, mtime: null, size: null };
    expect(imageRev(unhydrated)).toBe("");
    const hydrated = { icon: tok, mtime: 1000, size: 10 };
    // Hydration establishes the baseline without a refetch.
    expect(imageRev(hydrated)).toBe("");
    expect(imageRev(hydrated)).toBe("");
    // A watcher upsert with new content: same token, new URL.
    const edited = { icon: tok, mtime: 2000.7, size: 12 };
    expect(imageRev(edited)).toBe("2000-12");
    const e = { ...edited, id: 1, name: "a.png" } as never;
    expect(entryThumbUrl(e, 128)).toBe(`thumb://localhost/${tok}?size=128&v=2000-12`);
    expect(entryIconUrl(e, 32)).toBe(`icon://localhost/${tok}?size=32&v=2000-12`);
    // Same-size edit still changes the URL.
    expect(imageRev({ icon: tok, mtime: 3000, size: 12 })).toBe("3000-12");
    // Reverting to the baseline content falls back to the plain URL.
    expect(imageRev(hydrated)).toBe("");
  });

  it("tracks tokens independently", () => {
    expect(imageRev({ icon: "a", mtime: 1, size: 1 })).toBe("");
    expect(imageRev({ icon: "b", mtime: 2, size: 2 })).toBe("");
    expect(imageRev({ icon: "a", mtime: 2, size: 2 })).toBe("2-2");
  });
});
