/** applyBatchRename spec tables + collision classification. */
import { describe, expect, it } from "vitest";
import { applyBatchRename, batchCollisions, compileFind } from "../batchRename";

describe("applyBatchRename", () => {
  it("regex find/replace with capture groups, extension preserved", () => {
    const out = applyBatchRename(["IMG_0042.jpg", "IMG_0043.jpg"], {
      find: "IMG_(\\d+)",
      replace: "Vacation $1",
    });
    expect(out).toEqual(["Vacation 0042.jpg", "Vacation 0043.jpg"]);
  });

  it("case-insensitive find", () => {
    const out = applyBatchRename(["img_1.png"], {
      find: "img",
      replace: "photo",
      caseInsensitive: true,
    });
    expect(out).toEqual(["photo_1.png"]);
  });

  it("prefix and suffix insert around the stem, before the extension", () => {
    const out = applyBatchRename(["draft.md"], { prefix: "2026 ", suffix: " final" });
    expect(out).toEqual(["2026 draft final.md"]);
  });

  it("numbering: start/step/digits, prefix or suffix position", () => {
    const names = ["a.txt", "b.txt", "c.txt"];
    expect(
      applyBatchRename(names, { numbering: { start: 1, step: 1, digits: 2, position: "suffix" } }),
    ).toEqual(["a 01.txt", "b 02.txt", "c 03.txt"]);
    expect(
      applyBatchRename(names, { numbering: { start: 10, step: 5, digits: 3, position: "prefix" } }),
    ).toEqual(["010 a.txt", "015 b.txt", "020 c.txt"]);
  });

  it("pipeline order: replace → prefix/suffix → numbering", () => {
    const out = applyBatchRename(["track.mp3"], {
      find: "track",
      replace: "song",
      prefix: "The ",
      numbering: { start: 7, step: 1, digits: 1, position: "suffix" },
    });
    expect(out).toEqual(["The song 7.mp3"]);
  });

  it("an invalid regex leaves names untouched (and compileFind reports null)", () => {
    expect(compileFind({ find: "([" })).toBeNull();
    const out = applyBatchRename(["keep.txt"], { find: "([", replace: "x" });
    expect(out).toEqual(["keep.txt"]);
  });

  it("dotfiles keep their whole name as the stem", () => {
    const out = applyBatchRename([".gitignore"], { suffix: "-old" });
    expect(out).toEqual([".gitignore-old"]);
  });
});

describe("batchCollisions", () => {
  it("flags intra-batch duplicate targets case-insensitively", () => {
    const flags = batchCollisions(
      ["a.txt", "b.txt"],
      ["X.txt", "x.TXT"],
      ["a.txt", "b.txt"],
    );
    expect(flags).toEqual([true, true]);
  });

  it("flags collisions with non-batch siblings but not vacated batch names", () => {
    // "b.txt" is a sibling NOT in the batch → collision; "a.txt" is being
    // vacated by the batch itself → allowed (swap/case-only semantics).
    const flags = batchCollisions(["a.txt"], ["b.txt"], ["a.txt", "b.txt"]);
    expect(flags).toEqual([true]);
    const swap = batchCollisions(
      ["1.jpg", "2.jpg"],
      ["2.jpg", "1.jpg"],
      ["1.jpg", "2.jpg"],
    );
    expect(swap).toEqual([false, false]);
  });
});
