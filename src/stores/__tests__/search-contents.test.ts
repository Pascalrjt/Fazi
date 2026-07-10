/**
 * Content-search wiring: the Contents/Filename toggle re-runs the search with
 * `contents` on the wire, and a fresh search session starts from the
 * `searchContentsDefault` setting.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  searchCalls: [] as Array<{ searchId: string; query: string; scope: string | null; contents: boolean }>,
}));

vi.mock("../../lib/ipc", () => ({
  search: (args: { searchId: string; query: string; scope: string | null; contents: boolean }) => {
    mocks.searchCalls.push(args);
    return Promise.resolve();
  },
  cancelSearch: () => Promise.resolve(),
}));

import { useApp } from "../app";
import { useSettings } from "../settings";

describe("content-search toggle", () => {
  beforeEach(() => {
    mocks.searchCalls.length = 0;
    useApp.getState().closeGlobalSearch();
    useSettings.setState({ searchContentsDefault: false });
  });

  it("runGlobalSearch sends contents:true after the toggle flips", () => {
    const app = useApp.getState();
    app.openGlobalSearch("report", "folder");
    app.runGlobalSearch("report", "/Users/me");
    expect(mocks.searchCalls).toHaveLength(1);
    expect(mocks.searchCalls[0].contents).toBe(false);

    app.setSearchContents(true);
    app.runGlobalSearch("report", "/Users/me");
    expect(mocks.searchCalls).toHaveLength(2);
    expect(mocks.searchCalls[1].contents).toBe(true);
    expect(mocks.searchCalls[1].query).toBe("report");
  });

  it("a fresh search session starts from searchContentsDefault", () => {
    useSettings.setState({ searchContentsDefault: true });
    const app = useApp.getState();
    app.openGlobalSearch("notes", "home");
    expect(useApp.getState().globalSearch.contents).toBe(true);

    // Re-opening while already active must NOT clobber a per-session toggle.
    app.setSearchContents(false);
    app.openGlobalSearch("notes 2", "home");
    expect(useApp.getState().globalSearch.contents).toBe(false);
  });
});
