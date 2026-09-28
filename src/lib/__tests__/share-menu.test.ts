/** Share submenu: services first, then Finder's "Edit Extensions…" escape
 *  hatch to System Settings, where third-party extensions are enabled. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Entry } from "../../types/ipc";

const mocks = vi.hoisted(() => ({
  services: [] as Array<{ title: string; icon: string }>,
  openedSettings: 0,
}));

vi.mock("../ipc", () => ({
  shareServices: () => Promise.resolve({ generation: 1, services: mocks.services }),
  sharePerform: () => Promise.resolve(),
  openShareExtensionsSettings: () => {
    mocks.openedSettings++;
    return Promise.resolve();
  },
  listDir: () => Promise.resolve(),
  cancelListing: () => Promise.resolve(),
  watchDir: () => Promise.resolve(),
  unwatch: () => Promise.resolve(),
}));

import { shareMenuItems } from "../actions";

const entry: Entry = {
  id: 1,
  name: "a.txt",
  path: "/dir/a.txt",
  kind: "file",
  hidden: false,
  icon: "token-1",
  ext: "txt",
  hydrated: true,
  size: 1,
  mtime: 1,
  btime: 1,
  isPackage: false,
  isAlias: false,
  linkTarget: null,
  tags: [],
  noAccess: false,
};

const labels = (items: Awaited<ReturnType<ReturnType<typeof shareMenuItems>>>) =>
  items.map((i) => (i.type === "separator" ? "—" : i.label));

describe("shareMenuItems", () => {
  beforeEach(() => {
    mocks.openedSettings = 0;
  });

  it("ends with Edit Extensions… after the services", async () => {
    mocks.services = [
      { title: "AirDrop", icon: "" },
      { title: "Mail", icon: "" },
    ];
    const items = await shareMenuItems(entry)();
    expect(labels(items)).toEqual(["AirDrop", "Mail", "—", "Edit Extensions…"]);

    const edit = items[items.length - 1];
    if (edit.type !== "item") throw new Error("expected an item");
    edit.action?.();
    expect(mocks.openedSettings).toBe(1);
  });

  it("still offers Edit Extensions… when nothing can share", async () => {
    mocks.services = [];
    const items = await shareMenuItems(entry)();
    expect(labels(items)).toEqual(["No share destinations", "—", "Edit Extensions…"]);
  });
});
