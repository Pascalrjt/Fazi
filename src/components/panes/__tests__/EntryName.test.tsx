import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Entry } from "../../../types/ipc";
import { EntryName } from "../FileList";

function symlink(target: string): Entry {
  return {
    id: 1,
    name: "shortcut",
    path: "/dir/shortcut",
    kind: "symlink",
    hidden: false,
    icon: "token",
    ext: "",
    hydrated: true,
    size: 12,
    mtime: 1,
    btime: 1,
    isPackage: false,
    isAlias: false,
    linkTarget: target,
    tags: [],
    noAccess: false,
  };
}

describe("EntryName", () => {
  afterEach(cleanup);

  it("shows the exact stored target for normal and broken symlinks", () => {
    const { rerender } = render(<EntryName entry={symlink("../actual/file.txt")} />);
    const target = screen.getByTitle("../actual/file.txt");
    expect(target.textContent).toBe("→ ../actual/file.txt");

    rerender(<EntryName entry={symlink("../missing-target")} />);
    const brokenTarget = screen.getByTitle("../missing-target");
    expect(brokenTarget.textContent).toBe("→ ../missing-target");
  });
});
