import { describe, expect, it } from "vitest";
import type { Entry } from "../../types/ipc";
import { entryIconUrl, entryThumbUrl, imageRev } from "../imageRev";

const tok = "0123456789abcdef0123456789abcdef";
const row = (mtime: number | null, size: number | null) =>
  ({ id: 1, name: "a.png", icon: tok, mtime, size }) as Entry;

describe("image URL revisions", () => {
  it("unhydrated rows have no revision; hydrated rows carry mtime+size", () => {
    expect(entryThumbUrl(row(null, null), 128)).toBe(`thumb://localhost/${tok}?size=128`);
    expect(entryThumbUrl(row(2000.7, 12), 128)).toBe(`thumb://localhost/${tok}?size=128&v=2000-12`);
    expect(entryIconUrl(row(2000, null), 32)).toBe(`icon://localhost/${tok}?size=32&v=2000-0`);
  });

  it("an edit before the first hydrated render still changes the URL", () => {
    // Rendered pre-hydration, scrolled away; the file changed before the
    // row's next render. The hydrated URL differs from the one loaded.
    const loaded = entryThumbUrl(row(null, null), 128);
    const afterEdit = entryThumbUrl(row(5000, 9), 128);
    expect(afterEdit).not.toBe(loaded);
    // And any later edit (same size included) changes it again.
    expect(entryThumbUrl(row(6000, 9), 128)).not.toBe(afterEdit);
    expect(imageRev(row(6000, 9))).toBe("6000-9");
  });
});
