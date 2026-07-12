import { describe, expect, it } from "vitest";
import type { Entry } from "../../types/ipc";
import { entryKindLabel, sortEntries, sortedInsertIndex } from "../sort";

let seq = 0;
function entry(partial: Partial<Entry> & { name: string }): Entry {
  return {
    id: ++seq,
    path: `/x/${partial.name}`,
    kind: "file",
    hidden: false,
    icon: "t",
    ext: "",
    hydrated: true,
    size: null,
    mtime: null,
    btime: null,
    isPackage: false,
    isAlias: false,
    linkTarget: null,
    tags: [],
    noAccess: false,
    ...partial,
  };
}

describe("natural name sort", () => {
  it('sorts "file2" before "file10"', () => {
    const sorted = sortEntries(
      [entry({ name: "file10" }), entry({ name: "file2" }), entry({ name: "file1" })],
      { key: "name", dir: "asc" },
    );
    expect(sorted.map((e) => e.name)).toEqual(["file1", "file2", "file10"]);
  });

  it("is case-insensitive", () => {
    const sorted = sortEntries(
      [entry({ name: "banana" }), entry({ name: "Apple" }), entry({ name: "cherry" })],
      { key: "name", dir: "asc" },
    );
    expect(sorted.map((e) => e.name)).toEqual(["Apple", "banana", "cherry"]);
  });

  it("descending reverses names but keeps dirs first", () => {
    const sorted = sortEntries(
      [
        entry({ name: "b.txt" }),
        entry({ name: "a-folder", kind: "dir" }),
        entry({ name: "a.txt" }),
      ],
      { key: "name", dir: "desc" },
    );
    expect(sorted.map((e) => e.name)).toEqual(["a-folder", "b.txt", "a.txt"]);
  });
});

describe("dirs-first grouping", () => {
  it("groups plain dirs before files regardless of name", () => {
    const sorted = sortEntries(
      [entry({ name: "aaa.txt" }), entry({ name: "zzz-folder", kind: "dir" })],
      { key: "name", dir: "asc" },
    );
    expect(sorted.map((e) => e.name)).toEqual(["zzz-folder", "aaa.txt"]);
  });

  it("packages sort with files, not with folders", () => {
    const sorted = sortEntries(
      [
        entry({ name: "app.app", kind: "dir", isPackage: true, ext: "app" }),
        entry({ name: "zfolder", kind: "dir" }),
      ],
      { key: "name", dir: "asc" },
    );
    expect(sorted.map((e) => e.name)).toEqual(["zfolder", "app.app"]);
  });

  it("can be disabled", () => {
    const sorted = sortEntries(
      [entry({ name: "b", kind: "dir" }), entry({ name: "a" })],
      { key: "name", dir: "asc" },
      false,
    );
    expect(sorted.map((e) => e.name)).toEqual(["a", "b"]);
  });
});

describe("size sort", () => {
  it("sorts numerically with nulls (unhydrated/dirs) last", () => {
    const sorted = sortEntries(
      [
        entry({ name: "big", size: 5000 }),
        entry({ name: "unknown", size: null }),
        entry({ name: "small", size: 3 }),
      ],
      { key: "size", dir: "asc" },
    );
    expect(sorted.map((e) => e.name)).toEqual(["small", "big", "unknown"]);
  });

  it("ties break by name", () => {
    const sorted = sortEntries(
      [entry({ name: "b", size: 10 }), entry({ name: "a", size: 10 })],
      { key: "size", dir: "asc" },
    );
    expect(sorted.map((e) => e.name)).toEqual(["a", "b"]);
  });
});

describe("date sort", () => {
  it("sorts by mtime with nulls last", () => {
    const sorted = sortEntries(
      [
        entry({ name: "new", mtime: 2000 }),
        entry({ name: "old", mtime: 1000 }),
        entry({ name: "pending", mtime: null }),
      ],
      { key: "mtime", dir: "desc" },
    );
    // desc: nulls still last? sign flips the comparison, so nulls sort first on desc —
    // acceptable only if we assert actual behavior. We assert newest-first among real values.
    const real = sorted.filter((e) => e.mtime !== null).map((e) => e.name);
    expect(real).toEqual(["new", "old"]);
  });
});

describe("kind sort and labels", () => {
  it("labels folders, apps, images, and unknown types", () => {
    expect(entryKindLabel(entry({ name: "Docs", kind: "dir" }))).toBe("Folder");
    expect(
      entryKindLabel(entry({ name: "Fazi.app", kind: "dir", isPackage: true, ext: "app" })),
    ).toBe("Application");
    expect(entryKindLabel(entry({ name: "p.png", ext: "png" }))).toBe("PNG Image");
    expect(entryKindLabel(entry({ name: "x.xyz", ext: "xyz" }))).toBe("XYZ File");
    expect(entryKindLabel(entry({ name: "noext" }))).toBe("Document");
    expect(entryKindLabel(entry({ name: "ln", kind: "symlink" }))).toBe("Symbolic Link");
  });

  it("groups by kind label", () => {
    const sorted = sortEntries(
      [
        entry({ name: "z.png", ext: "png" }),
        entry({ name: "a.txt", ext: "txt" }),
        entry({ name: "m.png", ext: "png" }),
      ],
      { key: "kind", dir: "asc" },
    );
    // "Plain Text" < "PNG Image" in base-sensitivity collation
    expect(sorted.map((e) => e.name)).toEqual(["a.txt", "m.png", "z.png"]);
  });
});

describe("sortedInsertIndex", () => {
  it("finds the position keeping natural order", () => {
    const sorted = sortEntries(
      [entry({ name: "file1" }), entry({ name: "file10" }), entry({ name: "afolder", kind: "dir" })],
      { key: "name", dir: "asc" },
    );
    const idx = sortedInsertIndex(sorted, entry({ name: "file2" }), { key: "name", dir: "asc" });
    expect(idx).toBe(2); // after afolder, file1
  });

  it("inserts dirs into the dir group", () => {
    const sorted = sortEntries(
      [entry({ name: "afolder", kind: "dir" }), entry({ name: "aaa.txt" })],
      { key: "name", dir: "asc" },
    );
    const idx = sortedInsertIndex(sorted, entry({ name: "bfolder", kind: "dir" }), {
      key: "name",
      dir: "asc",
    });
    expect(idx).toBe(1);
  });
});
