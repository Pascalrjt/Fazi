/**
 * Sidebar-favorites persistence: dedupe against pins AND default folders,
 * removal, reorder clamping, and — critically — rehydrating a real persisted
 * version-0 `fazi-settings` blob without `favorites` must preserve existing
 * keys and default `favorites: []` (guards the no-version-bump decision).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { useSettings } from "../settings";

const DEFAULTS = ["/Users/me", "/Users/me/Desktop", "/Users/me/Downloads"];

function paths(): string[] {
  return useSettings.getState().favorites.map((f) => f.path);
}

beforeEach(() => {
  useSettings.setState({ favorites: [] });
});

describe("addFavorites", () => {
  it("adds folders and reports the count", () => {
    const added = useSettings.getState().addFavorites(
      [
        { path: "/p/Projects", name: "Projects" },
        { path: "/p/Notes", name: "Notes" },
      ],
      DEFAULTS,
    );
    expect(added).toBe(2);
    expect(paths()).toEqual(["/p/Projects", "/p/Notes"]);
  });

  it("dedupes against already-pinned paths", () => {
    useSettings.getState().addFavorites([{ path: "/p/Projects", name: "Projects" }], DEFAULTS);
    const added = useSettings.getState().addFavorites(
      [
        { path: "/p/Projects", name: "Projects" },
        { path: "/p/New", name: "New" },
      ],
      DEFAULTS,
    );
    expect(added).toBe(1);
    expect(paths()).toEqual(["/p/Projects", "/p/New"]);
  });

  it("dedupes against the default sidebar folders", () => {
    // Pinning ~/Downloads would show "Downloads" twice.
    const added = useSettings.getState().addFavorites(
      [{ path: "/Users/me/Downloads", name: "Downloads" }],
      DEFAULTS,
    );
    expect(added).toBe(0);
    expect(paths()).toEqual([]);
  });

  it("dedupes duplicates within one call", () => {
    const added = useSettings.getState().addFavorites(
      [
        { path: "/p/A", name: "A" },
        { path: "/p/A", name: "A" },
      ],
      DEFAULTS,
    );
    expect(added).toBe(1);
  });
});

describe("addFavorites at index", () => {
  beforeEach(() => {
    useSettings.getState().addFavorites(
      [
        { path: "/p/A", name: "A" },
        { path: "/p/B", name: "B" },
      ],
      [],
    );
  });

  it("inserts at 0 (prepend)", () => {
    useSettings.getState().addFavorites([{ path: "/p/X", name: "X" }], [], 0);
    expect(paths()).toEqual(["/p/X", "/p/A", "/p/B"]);
  });

  it("inserts at a middle index", () => {
    useSettings.getState().addFavorites([{ path: "/p/X", name: "X" }], [], 1);
    expect(paths()).toEqual(["/p/A", "/p/X", "/p/B"]);
  });

  it("clamps out-of-range and negative indices", () => {
    useSettings.getState().addFavorites([{ path: "/p/X", name: "X" }], [], 99);
    expect(paths()).toEqual(["/p/A", "/p/B", "/p/X"]);
    useSettings.getState().addFavorites([{ path: "/p/Y", name: "Y" }], [], -5);
    expect(paths()).toEqual(["/p/Y", "/p/A", "/p/B", "/p/X"]);
  });

  it("skips dupes (never moves them) and inserts fresh items contiguously", () => {
    const added = useSettings.getState().addFavorites(
      [
        { path: "/p/B", name: "B" }, // already pinned — stays at its slot
        { path: "/p/X", name: "X" },
        { path: "/p/Y", name: "Y" },
      ],
      [],
      1,
    );
    expect(added).toBe(2);
    expect(paths()).toEqual(["/p/A", "/p/X", "/p/Y", "/p/B"]);
  });

  it("omitted index appends", () => {
    useSettings.getState().addFavorites([{ path: "/p/X", name: "X" }], []);
    expect(paths()).toEqual(["/p/A", "/p/B", "/p/X"]);
  });
});

describe("removeFavorite", () => {
  it("removes by path", () => {
    useSettings.getState().addFavorites(
      [
        { path: "/p/A", name: "A" },
        { path: "/p/B", name: "B" },
      ],
      [],
    );
    useSettings.getState().removeFavorite("/p/A");
    expect(paths()).toEqual(["/p/B"]);
    // Unknown paths are a no-op.
    useSettings.getState().removeFavorite("/p/none");
    expect(paths()).toEqual(["/p/B"]);
  });
});

describe("moveFavorite", () => {
  beforeEach(() => {
    useSettings.getState().addFavorites(
      [
        { path: "/p/A", name: "A" },
        { path: "/p/B", name: "B" },
        { path: "/p/C", name: "C" },
        { path: "/p/D", name: "D" },
      ],
      [],
    );
  });

  it("moves forward using a pre-removal insertion index", () => {
    // Drop A between B and C (insertion index 2) → B A C D.
    useSettings.getState().moveFavorite("/p/A", 2);
    expect(paths()).toEqual(["/p/B", "/p/A", "/p/C", "/p/D"]);
  });

  it("moves backward", () => {
    useSettings.getState().moveFavorite("/p/D", 0);
    expect(paths()).toEqual(["/p/D", "/p/A", "/p/B", "/p/C"]);
  });

  it("clamps out-of-range indices", () => {
    useSettings.getState().moveFavorite("/p/A", 99);
    expect(paths()).toEqual(["/p/B", "/p/C", "/p/D", "/p/A"]);
    useSettings.getState().moveFavorite("/p/A", -5);
    expect(paths()).toEqual(["/p/A", "/p/B", "/p/C", "/p/D"]);
  });

  it("ignores unknown paths", () => {
    useSettings.getState().moveFavorite("/p/none", 0);
    expect(paths()).toEqual(["/p/A", "/p/B", "/p/C", "/p/D"]);
  });
});

describe("rehydrating an old persisted blob", () => {
  it("keeps existing keys and defaults favorites to [] (version-0 blob)", async () => {
    // A real pre-favorites blob: implicit version 0, no `favorites` key.
    localStorage.setItem(
      "fazi-settings",
      JSON.stringify({
        state: {
          showHidden: true,
          viewMode: "grid",
          sidebarCollapsed: false,
          defaultSortKey: "size",
          defaultSortDir: "desc",
          fdaBannerDismissed: true,
        },
        version: 0,
      }),
    );
    await useSettings.persist.rehydrate();
    const s = useSettings.getState();
    // Shallow merge keeps every persisted key…
    expect(s.showHidden).toBe(true);
    expect(s.viewMode).toBe("grid");
    expect(s.defaultSortKey).toBe("size");
    expect(s.defaultSortDir).toBe("desc");
    expect(s.fdaBannerDismissed).toBe(true);
    // …and the new key falls back to its default instead of the whole store
    // being discarded (which a version bump without migrate would cause).
    expect(s.favorites).toEqual([]);
    localStorage.removeItem("fazi-settings");
  });
});
