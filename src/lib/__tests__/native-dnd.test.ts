/**
 * Native drag-out state machine + self-drop dispatch: flags set/cleared
 * (including on a rejected startDrag), self-drop → internal move, ⌥ → copy,
 * trash zones → trash_paths, and the bridge/fallback double-dispatch guard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runOpCalls: [] as Array<{ kind: string; sources: string[]; destDir: string }>,
  trashPathsCalls: [] as string[][],
  pinCalls: [] as Array<{ paths: string[]; atIndex: number | undefined }>,
  dragDropHandler: null as ((event: { payload: unknown }) => void) | null,
  startDragImpl: (() => Promise.resolve()) as (
    opts: unknown,
    cb?: (p: { result: string; cursorPos: { x: number; y: number } }) => void,
  ) => Promise<void>,
}));

vi.mock("../pin", () => ({
  pinFolders: (paths: string[], atIndex?: number) => {
    mocks.pinCalls.push({ paths, atIndex });
    return Promise.resolve();
  },
  defaultSidebarPaths: () => [],
}));

vi.mock("../ipc", () => ({
  runOp: (args: { kind: string; sources: string[]; destDir: string }) => {
    mocks.runOpCalls.push({ kind: args.kind, sources: args.sources, destDir: args.destDir });
    return Promise.resolve();
  },
  trashPaths: (paths: string[]) => {
    mocks.trashPathsCalls.push(paths);
    return Promise.resolve();
  },
  cancelOp: () => Promise.resolve(),
  undoLast: () => Promise.resolve(null),
  redoLast: () => Promise.resolve(null),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (cb: (event: { payload: unknown }) => void) => {
      mocks.dragDropHandler = cb;
      return Promise.resolve(() => {});
    },
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    innerPosition: () => Promise.resolve({ x: 0, y: 0 }),
    scaleFactor: () => Promise.resolve(1),
  }),
}));
vi.mock("@crabnebula/tauri-plugin-drag", () => ({
  startDrag: (opts: unknown, cb?: (p: { result: string; cursorPos: { x: number; y: number } }) => void) =>
    mocks.startDragImpl(opts, cb),
}));

import {
  activeDragPaths,
  altHeldDuringDrag,
  beginNativeDragState,
  dispatchNativeSelfDrop,
  emitDropHover,
  endNativeDragState,
  markNativeDropHandled,
  nativeDragPathsNow,
  onDropHover,
  onPinHover,
  registerDropZone,
  setPointerDragPaths,
  SPRING_LOAD_MS,
  wasNativeDropHandled,
  type DropHover,
} from "../dnd";
import { setupFinderDragIn, startNativeDrag } from "../ipc/dnd";
import { useOps } from "../../stores/ops";

describe("native drag state", () => {
  beforeEach(() => {
    mocks.runOpCalls.length = 0;
    mocks.trashPathsCalls.length = 0;
    mocks.pinCalls.length = 0;
    endNativeDragState();
    useOps.setState({ cards: [], conflicts: [] });
  });

  it("begin/mark/end round-trip", () => {
    expect(nativeDragPathsNow()).toBeNull();
    beginNativeDragState(["/a/x.txt"], true);
    expect(nativeDragPathsNow()).toEqual(["/a/x.txt"]);
    expect(altHeldDuringDrag()).toBe(true);
    expect(wasNativeDropHandled()).toBe(false);
    markNativeDropHandled();
    expect(wasNativeDropHandled()).toBe(true);
    endNativeDragState();
    expect(nativeDragPathsNow()).toBeNull();
    expect(wasNativeDropHandled()).toBe(false);
    expect(altHeldDuringDrag()).toBe(false);
  });

  it("a rejected startDrag clears the flag (never wedges move semantics)", async () => {
    mocks.startDragImpl = () => Promise.reject(new Error("no backend"));
    startNativeDrag(["/a/x.txt"], false);
    expect(nativeDragPathsNow()).toEqual(["/a/x.txt"]);
    await new Promise((r) => setTimeout(r, 0));
    expect(nativeDragPathsNow()).toBeNull();
  });

  it("a cancelled session clears the flag via the completion callback", async () => {
    let callback: ((p: { result: string; cursorPos: { x: number; y: number } }) => void) | undefined;
    mocks.startDragImpl = (_o, cb) => {
      callback = cb;
      return Promise.resolve();
    };
    startNativeDrag(["/a/x.txt"], false);
    expect(nativeDragPathsNow()).toEqual(["/a/x.txt"]);
    callback?.({ result: "Cancelled", cursorPos: { x: 0, y: 0 } });
    expect(nativeDragPathsNow()).toBeNull();
  });

  it("self-drop dispatches an internal move; ⌥ makes it a copy", () => {
    dispatchNativeSelfDrop({ destDir: "/dest", action: "copyTo" }, ["/src/a.txt"], false);
    expect(mocks.runOpCalls).toEqual([
      { kind: "move", sources: ["/src/a.txt"], destDir: "/dest" },
    ]);
    dispatchNativeSelfDrop({ destDir: "/dest", action: "copyTo" }, ["/src/b.txt"], true);
    expect(mocks.runOpCalls[1].kind).toBe("copy");
  });

  it("self-drop on the trash zone trashes; same-dir self-drop is a no-op", async () => {
    dispatchNativeSelfDrop({ destDir: "/Users/me/.Trash", action: "trash" }, ["/src/a.txt"], false);
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.trashPathsCalls).toEqual([["/src/a.txt"]]);
    // dropping into the folder the item already lives in
    dispatchNativeSelfDrop({ destDir: "/src", action: "copyTo" }, ["/src/a.txt"], false);
    expect(mocks.runOpCalls).toHaveLength(0);
  });

  it("fallback hit-test dispatches when the bridge never claimed the drop", async () => {
    const unregister = registerDropZone({
      priority: 1,
      hitTest: (x, y) =>
        x >= 0 && x <= 100 && y >= 0 && y <= 100
          ? { action: "copyTo", destDir: "/zone" }
          : null,
    });
    let callback: ((p: { result: string; cursorPos: { x: number; y: number } }) => void) | undefined;
    mocks.startDragImpl = (_o, cb) => {
      callback = cb;
      return Promise.resolve();
    };
    // jsdom window is 1024x768 — the cursor lands inside it.
    startNativeDrag(["/elsewhere/f.txt"], false);
    await new Promise((r) => setTimeout(r, 0));
    callback?.({ result: "Dropped", cursorPos: { x: 50, y: 50 } });
    await new Promise((r) => setTimeout(r, 200));
    expect(mocks.runOpCalls).toEqual([
      { kind: "move", sources: ["/elsewhere/f.txt"], destDir: "/zone" },
    ]);
    expect(nativeDragPathsNow()).toBeNull();
    unregister();
  });

  it("fallback stays silent when the bridge already handled the drop", async () => {
    const unregister = registerDropZone({
      priority: 1,
      hitTest: () => ({ action: "copyTo", destDir: "/zone" }),
    });
    let callback: ((p: { result: string; cursorPos: { x: number; y: number } }) => void) | undefined;
    mocks.startDragImpl = (_o, cb) => {
      callback = cb;
      return Promise.resolve();
    };
    startNativeDrag(["/elsewhere/f.txt"], false);
    await new Promise((r) => setTimeout(r, 0));
    markNativeDropHandled(); // the bridge claimed it
    callback?.({ result: "Dropped", cursorPos: { x: 50, y: 50 } });
    await new Promise((r) => setTimeout(r, 200));
    expect(mocks.runOpCalls).toHaveLength(0);
    expect(nativeDragPathsNow()).toBeNull();
    unregister();
  });
});

/**
 * The sidebar Favorites native-drag contract: row centers copy into the
 * folder (copyTo zone, priority 16), row edges and section whitespace pin
 * (pin zone, priority 15). Zones here mirror the shapes Sidebar registers:
 * one 28px row at y 100–128 whose edge bands return null, inside a section
 * spanning y 60–200.
 */
describe("native pin contract (favorites zones)", () => {
  const ROW = { left: 0, right: 200, top: 100, bottom: 128 };
  const SECTION = { left: 0, right: 200, top: 60, bottom: 200 };
  const EDGE = 0.25;
  const unregisters: Array<() => void> = [];

  beforeEach(() => {
    mocks.runOpCalls.length = 0;
    mocks.trashPathsCalls.length = 0;
    mocks.pinCalls.length = 0;
    mocks.dragDropHandler = null;
    endNativeDragState();
    useOps.setState({ cards: [], conflicts: [] });
    unregisters.push(
      registerDropZone({
        priority: 16,
        hitTest: (x, y) => {
          if (x < ROW.left || x > ROW.right || y < ROW.top || y > ROW.bottom) return null;
          const frac = (y - ROW.top) / (ROW.bottom - ROW.top);
          if (frac < EDGE || frac > 1 - EDGE) return null; // edge → pin zone wins
          return { action: "copyTo", destDir: "/fav/A" };
        },
      }),
      registerDropZone({
        priority: 15,
        hitTest: (x, y) => {
          if (x < SECTION.left || x > SECTION.right || y < SECTION.top || y > SECTION.bottom) {
            return null;
          }
          // Row midpoint is y 114: above → slot 0, below → slot 1.
          return { action: "pin", index: y < 114 ? 0 : 1 };
        },
      }),
    );
  });

  afterEach(() => {
    while (unregisters.length > 0) unregisters.pop()?.();
  });

  async function bridge(): Promise<(event: { payload: unknown }) => void> {
    await setupFinderDragIn();
    const handler = mocks.dragDropHandler;
    if (!handler) throw new Error("onDragDropEvent handler not captured");
    return handler;
  }

  it("dispatchNativeSelfDrop on a pin hit pins and starts no op", () => {
    dispatchNativeSelfDrop({ action: "pin", index: 1 }, ["/x/Folder"], false);
    expect(mocks.pinCalls).toEqual([{ paths: ["/x/Folder"], atIndex: 1 }]);
    expect(mocks.runOpCalls).toHaveLength(0);
    expect(mocks.trashPathsCalls).toHaveLength(0);
  });

  it("hover over a row edge publishes an insertion index; row center publishes null", async () => {
    const handler = await bridge();
    const seen: Array<number | null> = [];
    const off = onPinHover((i) => seen.push(i));
    handler({ payload: { type: "over", position: { x: 50, y: 102 } } }); // top edge band
    handler({ payload: { type: "over", position: { x: 50, y: 114 } } }); // center
    off();
    expect(seen).toEqual([0, null]);
  });

  it("enter behaves like over — enter then drop without movement pins at that slot", async () => {
    const handler = await bridge();
    const seen: Array<number | null> = [];
    const off = onPinHover((i) => seen.push(i));
    handler({ payload: { type: "enter", position: { x: 50, y: 125 } } }); // bottom edge band
    handler({
      payload: { type: "drop", paths: ["/ext/Folder"], position: { x: 50, y: 125 } },
    });
    off();
    expect(seen).toEqual([1, null]); // enter published, drop cleared
    expect(mocks.pinCalls).toEqual([{ paths: ["/ext/Folder"], atIndex: 1 }]);
    expect(mocks.runOpCalls).toHaveLength(0);
  });

  it("Finder drop on a row center copies into the folder and never pins", async () => {
    const handler = await bridge();
    handler({
      payload: { type: "drop", paths: ["/ext/Folder"], position: { x: 50, y: 114 } },
    });
    expect(mocks.runOpCalls).toEqual([
      { kind: "copy", sources: ["/ext/Folder"], destDir: "/fav/A" },
    ]);
    expect(mocks.pinCalls).toHaveLength(0);
  });

  it("native self-drop on a row center moves into the folder and never pins", async () => {
    const handler = await bridge();
    beginNativeDragState(["/src/Folder"], false);
    handler({
      payload: { type: "drop", paths: ["/src/Folder"], position: { x: 50, y: 114 } },
    });
    expect(mocks.runOpCalls).toEqual([
      { kind: "move", sources: ["/src/Folder"], destDir: "/fav/A" },
    ]);
    expect(mocks.pinCalls).toHaveLength(0);
    endNativeDragState();
  });

  it("drop on section whitespace pins at the computed slot", async () => {
    const handler = await bridge();
    handler({
      payload: { type: "drop", paths: ["/ext/Folder"], position: { x: 50, y: 170 } },
    });
    expect(mocks.pinCalls).toEqual([{ paths: ["/ext/Folder"], atIndex: 1 }]);
    expect(mocks.runOpCalls).toHaveLength(0);
  });
});

describe("drop-hover broadcast", () => {
  beforeEach(() => {
    mocks.dragDropHandler = null;
    endNativeDragState();
  });

  it("over a copyTo zone broadcasts the full hit with client coords", async () => {
    const unregister = registerDropZone({
      priority: 1,
      hitTest: (x, y) =>
        x >= 0 && x <= 100 && y >= 0 && y <= 100
          ? { action: "copyTo", destDir: "/zone", targetKey: "row:z" }
          : null,
    });
    await setupFinderDragIn();
    const handler = mocks.dragDropHandler;
    if (!handler) throw new Error("handler not captured");
    const seen: Array<DropHover | null> = [];
    const off = onDropHover((h) => seen.push(h));
    handler({ payload: { type: "over", position: { x: 50, y: 50 } } });
    handler({ payload: { type: "over", position: { x: 500, y: 500 } } }); // off-zone
    handler({ payload: { type: "leave" } });
    off();
    unregister();
    expect(seen).toEqual([
      { hit: { action: "copyTo", destDir: "/zone", targetKey: "row:z" }, x: 50, y: 50 },
      null,
      null,
    ]);
  });

  it("onPinHover filters non-pin hovers to null", () => {
    const seen: Array<number | null> = [];
    const off = onPinHover((i) => seen.push(i));
    emitDropHover({ hit: { action: "copyTo", destDir: "/d" }, x: 1, y: 1 });
    emitDropHover({ hit: { action: "pin", index: 3 }, x: 1, y: 1 });
    emitDropHover(null);
    off();
    expect(seen).toEqual([null, 3, null]);
  });
});

describe("spring-loaded folders", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    endNativeDragState(); // also cancels any armed spring
  });

  afterEach(() => {
    emitDropHover(null);
    vi.useRealTimers();
  });

  function springHover(key: string, open: () => void): DropHover {
    return {
      hit: { action: "copyTo", destDir: `/dir/${key}`, targetKey: key, spring: { key, open } },
      x: 10,
      y: 10,
    };
  }

  it("fires open() once after the dwell; jitter on the same key keeps the timer", () => {
    const open = vi.fn();
    emitDropHover(springHover("row:a", open));
    vi.advanceTimersByTime(SPRING_LOAD_MS / 2);
    emitDropHover(springHover("row:a", open)); // same key mid-dwell: no reset
    vi.advanceTimersByTime(SPRING_LOAD_MS / 2);
    expect(open).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(SPRING_LOAD_MS * 2);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("a key change restarts the dwell for the new target", () => {
    const a = vi.fn();
    const b = vi.fn();
    emitDropHover(springHover("row:a", a));
    vi.advanceTimersByTime(SPRING_LOAD_MS - 1);
    emitDropHover(springHover("row:b", b));
    vi.advanceTimersByTime(SPRING_LOAD_MS - 1);
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("null hover and endNativeDragState both cancel the dwell", () => {
    const open = vi.fn();
    emitDropHover(springHover("row:a", open));
    emitDropHover(null);
    vi.advanceTimersByTime(SPRING_LOAD_MS * 2);
    expect(open).not.toHaveBeenCalled();

    emitDropHover(springHover("row:a", open));
    endNativeDragState(); // Esc-cancelled session, no leave event
    vi.advanceTimersByTime(SPRING_LOAD_MS * 2);
    expect(open).not.toHaveBeenCalled();
  });

  it("a background copyTo hit (no spring) never arms and cancels a running dwell", () => {
    const open = vi.fn();
    emitDropHover(springHover("row:a", open));
    emitDropHover({ hit: { action: "copyTo", destDir: "/pane" }, x: 10, y: 10 });
    vi.advanceTimersByTime(SPRING_LOAD_MS * 2);
    expect(open).not.toHaveBeenCalled();
  });
});

describe("activeDragPaths", () => {
  it("reflects native session paths, then pointer-drag paths, else null", () => {
    expect(activeDragPaths()).toBeNull();
    beginNativeDragState(["/a"], false);
    expect(activeDragPaths()).toEqual(["/a"]);
    endNativeDragState();
    expect(activeDragPaths()).toBeNull();
    setPointerDragPaths(["/b"]);
    expect(activeDragPaths()).toEqual(["/b"]);
    setPointerDragPaths(null);
    expect(activeDragPaths()).toBeNull();
  });
});
