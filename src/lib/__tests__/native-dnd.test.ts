/**
 * Native drag-out state machine + self-drop dispatch: flags set/cleared
 * (including on a rejected startDrag), self-drop → internal move, ⌥ → copy,
 * trash zones → trash_paths, and the bridge/fallback double-dispatch guard.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runOpCalls: [] as Array<{ kind: string; sources: string[]; destDir: string }>,
  trashPathsCalls: [] as string[][],
  startDragImpl: (() => Promise.resolve()) as (
    opts: unknown,
    cb?: (p: { result: string; cursorPos: { x: number; y: number } }) => void,
  ) => Promise<void>,
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
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
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
  altHeldDuringDrag,
  beginNativeDragState,
  dispatchNativeSelfDrop,
  endNativeDragState,
  markNativeDropHandled,
  nativeDragPathsNow,
  registerDropZone,
  wasNativeDropHandled,
} from "../dnd";
import { startNativeDrag } from "../ipc/dnd";
import { useOps } from "../../stores/ops";

describe("native drag state", () => {
  beforeEach(() => {
    mocks.runOpCalls.length = 0;
    mocks.trashPathsCalls.length = 0;
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
      hitTest: (x, y) => (x >= 0 && x <= 100 && y >= 0 && y <= 100 ? "/zone" : null),
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
      hitTest: () => "/zone",
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
