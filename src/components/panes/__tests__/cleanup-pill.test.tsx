/**
 * The auto-cleanup pill: a count in the footer that opens what's leaving,
 * the rule, and Select / Keep (or Show in the folder from elsewhere).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Entry } from "../../../types/ipc";

vi.mock("../../../lib/ipc", () => ({
  statPath: () => Promise.resolve(null),
}));

import { CleanupPill } from "../CleanupPill";
import { useCleanup, type CleanupEntry } from "../../../stores/cleanup";
import { usePanes } from "../../../stores/panes";
import { useSettings, SETTINGS_DEFAULTS } from "../../../stores/settings";
import { useApp } from "../../../stores/app";

const NOW = new Date(2026, 9, 13, 9, 0).getTime();
const DL = "/Users/me/Downloads";

function item(name: string, size: number, ino: number): CleanupEntry {
  return {
    path: `${DL}/${name}`,
    name,
    dev: 1,
    ino,
    isDir: false,
    size,
    added: NOW - 14 * 86_400_000,
    lastUsed: null,
    expires: NOW + 2 * 3_600_000,
    status: "scheduled",
    folder: DL,
    days: 14,
  };
}

function entry(id: number, name: string): Entry {
  return {
    id,
    name,
    path: `${DL}/${name}`,
    kind: "file",
    hidden: false,
    icon: "",
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
    customIcon: false,
  };
}

function seed(path: string): string {
  const s = usePanes.getState();
  const pane = s.panes[0];
  const tab = pane.tabs[0];
  usePanes.setState({
    panes: [
      {
        ...pane,
        activeTabId: tab.id,
        tabs: [
          {
            ...tab,
            path,
            entries: [entry(1, "a.dmg"), entry(2, "b.zip"), entry(3, "notes.txt")],
            loading: false,
            listed: true,
            selection: { selected: new Set<number>(), anchor: null, lead: null },
          },
        ],
      },
      ...s.panes.slice(1),
    ],
  });
  return tab.id;
}

describe("CleanupPill", () => {
  beforeEach(() => {
    useSettings.setState({ ...SETTINGS_DEFAULTS, cleanupEnabled: true });
    const items = [item("a.dmg", 9_400_000, 11), item("b.zip", 2_700_000, 12)];
    useCleanup.setState({ items: new Map(items.map((i) => [i.path, i])), folders: new Set([DL]), now: NOW });
    useApp.setState({ toasts: [] });
  });
  afterEach(cleanup);

  it("shows nothing when nothing is leaving", () => {
    useCleanup.setState({ items: new Map() });
    seed(DL);
    const { container } = render(<CleanupPill paneId="left" />);
    expect(container.innerHTML).toBe("");
  });

  it("opens the details: items, size, and the rule", () => {
    seed(DL);
    render(<CleanupPill paneId="left" />);
    fireEvent.click(screen.getByRole("button", { name: "2 items leave today" }));
    const text = screen.getByRole("dialog", { name: "Auto-cleanup" }).textContent ?? "";
    expect(text).toContain("2 items leave today");
    expect(text).toContain("12.1 MB");
    expect(text).toContain("a.dmg");
    expect(text).toContain("Cleared after 14 days");
    expect(text).not.toMatch(/sweep/i);
  });

  it("Select picks the leaving items in this folder", () => {
    const tabId = seed(DL);
    render(<CleanupPill paneId="left" />);
    fireEvent.click(screen.getByRole("button", { name: "2 items leave today" }));
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    const tab = usePanes.getState().panes[0].tabs.find((t) => t.id === tabId)!;
    expect([...tab.selection.selected].sort()).toEqual([1, 2]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Keep pins every leaving item", () => {
    seed(DL);
    render(<CleanupPill paneId="left" />);
    fireEvent.click(screen.getByRole("button", { name: "2 items leave today" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(useSettings.getState().cleanupKept.map((k) => k.ino).sort()).toEqual([11, 12]);
  });

  it("offers Show in Downloads from another folder", () => {
    const tabId = seed("/Users/me/Projects");
    const navigate = vi.fn();
    usePanes.setState({ navigate });
    render(<CleanupPill paneId="left" />);
    fireEvent.click(screen.getByRole("button", { name: "2 items leave today" }));
    expect(screen.queryByRole("button", { name: "Select" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show in Downloads" }));
    expect(navigate).toHaveBeenCalledWith("left", tabId, DL);
  });

  it("Escape closes it without reaching the window", () => {
    seed(DL);
    const onWindowKey = vi.fn();
    window.addEventListener("keydown", onWindowKey);
    render(<CleanupPill paneId="left" />);
    fireEvent.click(screen.getByRole("button", { name: "2 items leave today" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onWindowKey).not.toHaveBeenCalled();
    window.removeEventListener("keydown", onWindowKey);
  });

  it("Pause turns auto-cleanup off", () => {
    seed(DL);
    render(<CleanupPill paneId="left" />);
    fireEvent.click(screen.getByRole("button", { name: "2 items leave today" }));
    fireEvent.click(screen.getByRole("button", { name: "Pause auto-cleanup" }));
    expect(useSettings.getState().cleanupEnabled).toBe(false);
    expect(useApp.getState().toasts[0].message).toBe("Auto-cleanup is off");
  });
});
