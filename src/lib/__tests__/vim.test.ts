/**
 * Pure Vim interpreter: motions, counts, prefix sequences (no timeout —
 * pending survives until completed or cancelled), visual mode, and the
 * reserved-shortcut predicate that guards the keybinding editor.
 */
import { describe, expect, it } from "vitest";
import {
  emptyVimState,
  isVimReservedShortcut,
  nextVimState,
  vimPendingLabel,
  type VimState,
} from "../vim";
import { parseShortcut } from "../keyboard";

function feed(keys: Array<string | { key: string; ctrl: boolean }>, from?: VimState) {
  let state = from ?? emptyVimState();
  let last: ReturnType<typeof nextVimState> = { state, handled: false };
  for (const k of keys) {
    last = nextVimState(state, typeof k === "string" ? { key: k, ctrl: false } : k);
    state = last.state;
  }
  return last;
}

describe("motions and counts", () => {
  it("j moves down by 1", () => {
    const r = feed(["j"]);
    expect(r.handled).toBe(true);
    expect(r.action).toEqual({ kind: "move", dir: 1, count: 1, extend: false });
  });

  it("12j moves down by 12 and clears the count", () => {
    const r = feed(["1", "2", "j"]);
    expect(r.action).toEqual({ kind: "move", dir: 1, count: 12, extend: false });
    expect(r.state.count).toBe("");
  });

  it("10k accepts 0 as a count continuation", () => {
    const r = feed(["1", "0", "k"]);
    expect(r.action).toEqual({ kind: "move", dir: -1, count: 10, extend: false });
  });

  it("a bare 0 is not a Vim key", () => {
    const r = feed(["0"]);
    expect(r.handled).toBe(false);
  });

  it("h opens the parent, l opens the selection", () => {
    expect(feed(["h"]).action).toEqual({ kind: "openParent" });
    expect(feed(["l"]).action).toEqual({ kind: "open" });
  });

  it("an unrecognized key passes through and drops a stale count", () => {
    const r = feed(["5", "q"]);
    expect(r.handled).toBe(false);
    expect(r.state.count).toBe("");
  });
});

describe("prefix sequences (gg, yy, dd) — no timeout", () => {
  it("gg jumps to the first item", () => {
    const mid = feed(["g"]);
    expect(mid.handled).toBe(true);
    expect(mid.state.pending).toBe("g");
    expect(mid.action).toBeUndefined();
    const r = feed(["g"], mid.state);
    expect(r.action).toEqual({ kind: "edge", edge: "first", extend: false });
    expect(r.state.pending).toBeNull();
  });

  it("G jumps to the last item", () => {
    expect(feed(["G"]).action).toEqual({ kind: "edge", edge: "last", extend: false });
  });

  it("yy copies, dd cuts (never trashes)", () => {
    expect(feed(["y", "y"]).action).toEqual({ kind: "copy" });
    expect(feed(["d", "d"]).action).toEqual({ kind: "cut" });
  });

  it("gt / gT switch tabs and return to normal", () => {
    const t = feed(["g", "t"]);
    expect(t.action).toEqual({ kind: "nextTab" });
    expect(t.state.pending).toBeNull();
    const T = feed(["v", "g", "T"]);
    expect(T.action).toEqual({ kind: "prevTab" });
    expect(T.state.mode).toBe("normal");
  });

  it("g? opens the cheat sheet and returns to normal", () => {
    const r = feed(["g", "?"]);
    expect(r.action).toEqual({ kind: "openHelp" });
    expect(r.state.pending).toBeNull();
    const fromVisual = feed(["v", "g", "?"]);
    expect(fromVisual.action).toEqual({ kind: "openHelp" });
    expect(fromVisual.state.mode).toBe("normal");
  });

  it("m opens the context menu and gs cycles browse surfaces", () => {
    expect(feed(["m"]).action).toEqual({ kind: "openContextMenu" });
    expect(feed(["g", "s"]).action).toEqual({ kind: "cycleBrowseSurface" });
  });

  it("an unknown continuation cancels the prefix and swallows the key", () => {
    const r = feed(["d", "j"]);
    expect(r.handled).toBe(true);
    expect(r.action).toBeUndefined();
    expect(r.state.pending).toBeNull();
  });

  it("Escape cancels a pending prefix without acting", () => {
    const r = feed(["g", "Escape"]);
    expect(r.handled).toBe(true);
    expect(r.action).toBeUndefined();
    expect(r.state.pending).toBeNull();
  });

  it("Escape with nothing pending is not Vim's (registry cascade)", () => {
    expect(feed(["Escape"]).handled).toBe(false);
  });
});

describe("visual mode", () => {
  it("v enters visual, motions extend, v exits collapsing to the lead", () => {
    const enter = feed(["v"]);
    expect(enter.state.mode).toBe("visual");
    expect(enter.action).toEqual({ kind: "enterVisual" });

    const move = feed(["4", "j"], enter.state);
    expect(move.action).toEqual({ kind: "move", dir: 1, count: 4, extend: true });
    expect(move.state.mode).toBe("visual");

    const exit = feed(["v"], move.state);
    expect(exit.state.mode).toBe("normal");
    expect(exit.action).toEqual({ kind: "exitVisual" });
  });

  it("Escape exits visual", () => {
    const r = feed(["v", "Escape"]);
    expect(r.state.mode).toBe("normal");
    expect(r.action).toEqual({ kind: "exitVisual" });
  });

  it("gg and G extend in visual", () => {
    expect(feed(["v", "g", "g"]).action).toEqual({ kind: "edge", edge: "first", extend: true });
    expect(feed(["v", "G"]).action).toEqual({ kind: "edge", edge: "last", extend: true });
  });

  it("y and d act immediately in visual and return to normal", () => {
    const y = feed(["v", "y"]);
    expect(y.action).toEqual({ kind: "copy" });
    expect(y.state.mode).toBe("normal");
    const d = feed(["v", "d"]);
    expect(d.action).toEqual({ kind: "cut" });
    expect(d.state.mode).toBe("normal");
  });
});

describe("clipboard, undo, filter", () => {
  it("p pastes, u undoes, ctrl+r redoes", () => {
    expect(feed(["p"]).action).toEqual({ kind: "paste" });
    expect(feed(["u"]).action).toEqual({ kind: "undo" });
    expect(feed([{ key: "r", ctrl: true }]).action).toEqual({ kind: "redo" });
  });

  it(": opens the palette, ctrl+p the fuzzy finder, ? global search", () => {
    expect(feed([":"]).action).toEqual({ kind: "openPalette" });
    expect(feed([{ key: "p", ctrl: true }]).action).toEqual({ kind: "openFuzzy" });
    expect(feed(["?"]).action).toEqual({ kind: "openGlobalSearch" });
  });

  it("overlay keys exit visual mode", () => {
    for (const key of [":", "?"]) {
      const r = feed(["v", key]);
      expect(r.state.mode).toBe("normal");
      expect(r.action).toBeDefined();
    }
  });

  it("unrecognized ctrl combos pass through and clear pending", () => {
    const r = feed(["g", { key: "x", ctrl: true }]);
    expect(r.handled).toBe(false);
    expect(r.state.pending).toBeNull();
  });

  it("/ requests the filter and exits visual", () => {
    const r = feed(["v", "/"]);
    expect(r.action).toEqual({ kind: "focusFilter" });
    expect(r.state.mode).toBe("normal");
  });
});

describe("status label", () => {
  it("shows in-flight count and prefix", () => {
    expect(vimPendingLabel(emptyVimState())).toBe("");
    expect(vimPendingLabel(feed(["1", "2"]).state)).toBe("12");
    expect(vimPendingLabel(feed(["g"]).state)).toBe("g");
  });
});

describe("isVimReservedShortcut", () => {
  const reserved = [
    "j", "k", "h", "l", "g", "v", "y", "d", "p", "u", "m", "/", "5", "0",
    "shift+g", "ctrl+r", "ctrl+p", "shift+;", "shift+/",
  ];
  // t is free: gt only reserves g itself — continuations never dispatch alone.
  const free = ["cmd+j", "opt+d", "ctrl+shift+r", "shift+j", "t", "escape", "space", "enter", "cmd+shift+g", ";"];

  it.each(reserved)("reserves %s", (s) => {
    expect(isVimReservedShortcut(parseShortcut(s)!)).toBe(true);
  });

  it.each(free)("leaves %s available", (s) => {
    expect(isVimReservedShortcut(parseShortcut(s)!)).toBe(false);
  });
});
