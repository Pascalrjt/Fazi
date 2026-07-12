/**
 * Global-search plumbing: streamed hits batch into the store (no per-hit
 * set), the capped flag lands from Done, and indexed:false routes the
 * residual text + filters to the fuzzy walker fallback with its own
 * cancellable lifecycle (never for This Mac / Contents mode).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FuzzyEvent, SearchEvent } from "../../types/ipc";

const mocks = vi.hoisted(() => ({
  searchCalls: [] as Array<{
    args: {
      searchId: string;
      query: string;
      scope: string | null;
      contents: boolean;
      filters?: { kind?: string };
      maxResults?: number;
    };
    onEvent: (e: SearchEvent) => void;
  }>,
  fuzzyWarmCalls: [] as string[],
  fuzzyQueryCalls: [] as Array<{
    args: { root: string; query: string; queryId: string; live: boolean; maxResults: number };
    onEvent: (e: FuzzyEvent) => void;
  }>,
  fuzzyCancelCalls: [] as string[],
}));

vi.mock("../../lib/ipc", () => ({
  search: (args: never, onEvent: (e: SearchEvent) => void) => {
    mocks.searchCalls.push({ args, onEvent });
    return Promise.resolve();
  },
  cancelSearch: () => Promise.resolve(),
  fuzzyWarm: (root: string) => {
    mocks.fuzzyWarmCalls.push(root);
    return Promise.resolve({ indexed: 0, indexing: true, capped: false, builtAtMs: 1 });
  },
  fuzzyQuery: (args: never, onEvent: (e: FuzzyEvent) => void) => {
    mocks.fuzzyQueryCalls.push({ args, onEvent });
    return Promise.resolve();
  },
  fuzzyCancel: (queryId: string) => {
    mocks.fuzzyCancelCalls.push(queryId);
    return Promise.resolve();
  },
}));

import { useApp } from "../app";
import { useSettings } from "../settings";

function hit(path: string): SearchEvent {
  return { event: "hit", path, name: path.split("/").pop() ?? path, isDir: false, icon: "t" };
}

async function tick(ms = 80): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("global search plumbing", () => {
  beforeEach(() => {
    mocks.searchCalls.length = 0;
    mocks.fuzzyWarmCalls.length = 0;
    mocks.fuzzyQueryCalls.length = 0;
    mocks.fuzzyCancelCalls.length = 0;
    useApp.getState().closeGlobalSearch();
    useSettings.setState({ searchMaxResults: 500, searchContentsDefault: false });
  });

  it("passes parsed filters and maxResults on the wire", () => {
    const app = useApp.getState();
    app.openGlobalSearch("kind:pdf tax", "folder");
    app.runGlobalSearch("kind:pdf tax", "/Users/me");
    expect(mocks.searchCalls).toHaveLength(1);
    const { args } = mocks.searchCalls[0];
    expect(args.query).toBe("tax");
    expect(args.filters?.kind).toBe("pdf");
    expect(args.maxResults).toBe(500);
  });

  it("batches streamed hits and records the capped flag", async () => {
    const app = useApp.getState();
    app.openGlobalSearch("x", "folder");
    app.runGlobalSearch("x", "/Users/me");
    const { onEvent } = mocks.searchCalls[0];

    onEvent(hit("/a"));
    onEvent(hit("/b"));
    // buffered — not yet in the store
    expect(useApp.getState().globalSearch.hits).toHaveLength(0);
    await tick();
    expect(useApp.getState().globalSearch.hits.map((h) => h.path)).toEqual(["/a", "/b"]);

    onEvent(hit("/c"));
    onEvent({ event: "done", total: 3, capped: true, indexed: true });
    // done flushes synchronously
    expect(useApp.getState().globalSearch.hits).toHaveLength(3);
    expect(useApp.getState().globalSearch.status).toBe("done");
    expect(useApp.getState().globalSearch.capped).toBe(true);
    expect(mocks.fuzzyQueryCalls).toHaveLength(0);
  });

  it("indexed:false routes to the fuzzy fallback with the search cap as K", async () => {
    const app = useApp.getState();
    app.openGlobalSearch("kind:image beach", "folder");
    app.runGlobalSearch("kind:image beach", "/Volumes/USB");
    const { onEvent } = mocks.searchCalls[0];
    const searchId = mocks.searchCalls[0].args.searchId;

    onEvent({ event: "done", total: 0, capped: false, indexed: false });
    await tick(0);
    expect(mocks.fuzzyWarmCalls).toEqual(["/Volumes/USB"]);
    await tick(0);
    expect(mocks.fuzzyQueryCalls).toHaveLength(1);
    const fq = mocks.fuzzyQueryCalls[0];
    expect(fq.args.live).toBe(false);
    expect(fq.args.queryId).toBe(`search-${searchId}`);
    expect(fq.args.query).toBe("beach");
    expect(fq.args.maxResults).toBe(500);
    expect(useApp.getState().globalSearch.usedFallback).toBe(true);

    fq.onEvent({
      event: "results",
      queryId: fq.args.queryId,
      items: [{ path: "/Volumes/USB/b.png", name: "b.png", isDir: false, icon: "t", score: 9 }],
      indexed: 100,
      indexing: false,
    });
    fq.onEvent({ event: "done", queryId: fq.args.queryId, capped: false });
    const gs = useApp.getState().globalSearch;
    expect(gs.hits.map((h) => h.path)).toEqual(["/Volumes/USB/b.png"]);
    expect(gs.status).toBe("done");
  });

  it("never falls back for This Mac scope or Contents mode", async () => {
    const app = useApp.getState();
    // This Mac: scope null
    app.openGlobalSearch("x", "mac");
    app.runGlobalSearch("x", null);
    mocks.searchCalls[0].onEvent({ event: "done", total: 0, capped: false, indexed: false });
    await tick(0);
    expect(mocks.fuzzyQueryCalls).toHaveLength(0);
    expect(useApp.getState().globalSearch.status).toBe("done");

    // Contents mode
    app.setSearchContents(true);
    app.runGlobalSearch("x", "/Volumes/USB");
    mocks.searchCalls[1].onEvent({ event: "done", total: 0, capped: false, indexed: false });
    await tick(0);
    expect(mocks.fuzzyQueryCalls).toHaveLength(0);
  });

  it("replacing or closing the search cancels the in-flight fallback", async () => {
    const app = useApp.getState();
    app.openGlobalSearch("y", "folder");
    app.runGlobalSearch("y", "/Volumes/USB");
    const searchId = mocks.searchCalls[0].args.searchId;
    mocks.searchCalls[0].onEvent({ event: "done", total: 0, capped: false, indexed: false });
    await tick(0);
    await tick(0);
    expect(useApp.getState().globalSearch.fallbackQueryId).toBe(`search-${searchId}`);

    app.closeGlobalSearch();
    expect(mocks.fuzzyCancelCalls).toContain(`search-${searchId}`);
  });
});
