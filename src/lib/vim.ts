/**
 * Pure Vim-mode interpreter — no store imports, no DOM, fully unit-tested.
 *
 * Matches on KeyboardEvent.key (not code): Vim commands are *characters*
 * ("g" vs "G", "/"), so this naturally follows the user's layout, unlike the
 * code-based shortcut matcher in keyboard.ts. The impure adapter
 * (vimAdapter.ts) feeds keys through nextVimState and executes the returned
 * actions against the command registry and selection model.
 *
 * Sequences (gg, yy, dd) never time out: a pending prefix survives until it
 * completes, is cancelled by an unrecognized key or Escape, or the adapter
 * resets the state on a pane/tab/listing/context change.
 */
import type { ParsedShortcut } from "./keyboard";

export type VimMode = "normal" | "visual";

/** A one-key prefix awaiting its completion (gg / yy / dd). */
export type VimPending = "g" | "y" | "d";

export interface VimState {
  mode: VimMode;
  /** Accumulated count digits ("12" in `12j`); "" = none. */
  count: string;
  pending: VimPending | null;
}

/** Normalized keydown as seen by the reducer (meta/alt filtered upstream). */
export interface VimKey {
  key: string;
  ctrl: boolean;
}

export type VimAction =
  | { kind: "move"; dir: 1 | -1; count: number; extend: boolean }
  | { kind: "edge"; edge: "first" | "last"; extend: boolean }
  | { kind: "enterVisual" }
  | { kind: "exitVisual" }
  | { kind: "openParent" }
  | { kind: "open" }
  | { kind: "focusFilter" }
  | { kind: "openPalette" }
  | { kind: "openFuzzy" }
  | { kind: "openGlobalSearch" }
  | { kind: "nextTab" }
  | { kind: "prevTab" }
  | { kind: "copy" }
  | { kind: "cut" }
  | { kind: "paste" }
  | { kind: "undo" }
  | { kind: "redo" };

export interface VimStep {
  state: VimState;
  /** True = the key belongs to Vim; the event must not reach the registry. */
  handled: boolean;
  action?: VimAction;
}

export function emptyVimState(): VimState {
  return { mode: "normal", count: "", pending: null };
}

/** Status-bar suffix for in-flight input: "12", "g", "12g". */
export function vimPendingLabel(state: VimState): string {
  return state.count + (state.pending ?? "");
}

export function nextVimState(state: VimState, key: VimKey): VimStep {
  const clear = (mode: VimMode): VimState => ({ mode, count: "", pending: null });
  const done = (action: VimAction, mode: VimMode = state.mode): VimStep => ({
    state: clear(mode),
    handled: true,
    action,
  });

  if (key.ctrl) {
    if (state.pending === null) {
      if (key.key === "r") return done({ kind: "redo" }, "normal");
      if (key.key === "p") return done({ kind: "openFuzzy" }, "normal"); // ctrlp.vim heritage
    }
    // Unrecognized ctrl-combo: not Vim's — but stale prefixes must not linger.
    return { state: clear(state.mode), handled: false };
  }

  if (key.key === "Escape") {
    if (state.pending !== null || state.count !== "")
      return { state: clear(state.mode), handled: true };
    if (state.mode === "visual") return done({ kind: "exitVisual" }, "normal");
    // Nothing to cancel — the registry's cascading Escape takes it.
    return { state, handled: false };
  }

  if (state.pending !== null) {
    if (state.pending === "g") {
      if (key.key === "g")
        return done({ kind: "edge", edge: "first", extend: state.mode === "visual" });
      if (key.key === "t") return done({ kind: "nextTab" }, "normal");
      if (key.key === "T") return done({ kind: "prevTab" }, "normal");
    } else if (key.key === state.pending) {
      switch (state.pending) {
        case "y":
          return done({ kind: "copy" }, "normal");
        case "d":
          return done({ kind: "cut" }, "normal");
      }
    }
    // Unknown continuation (like Vim's unmapped g-commands): swallow, cancel.
    return { state: clear(state.mode), handled: true };
  }

  if (/^[1-9]$/.test(key.key) || (key.key === "0" && state.count !== "")) {
    return { state: { ...state, count: state.count + key.key }, handled: true };
  }

  const count = state.count === "" ? 1 : parseInt(state.count, 10);
  const extend = state.mode === "visual";
  switch (key.key) {
    case "j":
      return done({ kind: "move", dir: 1, count, extend });
    case "k":
      return done({ kind: "move", dir: -1, count, extend });
    case "h":
      return done({ kind: "openParent" }, "normal");
    case "l":
      return done({ kind: "open" }, "normal");
    case "g":
      return { state: { ...state, pending: "g" }, handled: true };
    case "G":
      return done({ kind: "edge", edge: "last", extend });
    case "v":
      return state.mode === "visual"
        ? done({ kind: "exitVisual" }, "normal")
        : done({ kind: "enterVisual" }, "visual");
    case "y":
      return state.mode === "visual"
        ? done({ kind: "copy" }, "normal")
        : { state: { ...state, count: "", pending: "y" }, handled: true };
    case "d":
      return state.mode === "visual"
        ? done({ kind: "cut" }, "normal")
        : { state: { ...state, count: "", pending: "d" }, handled: true };
    case "p":
      return done({ kind: "paste" }, "normal");
    case "u":
      return done({ kind: "undo" }, "normal");
    case "/":
      return done({ kind: "focusFilter" }, "normal");
    case "?":
      // The search pair: / = narrow (filter here), ? = wide (everywhere).
      return done({ kind: "openGlobalSearch" }, "normal");
    case ":":
      return done({ kind: "openPalette" }, "normal"); // the ex command line
  }

  // Not a Vim key: pass through, dropping any stale count.
  return { state: state.count === "" ? state : { ...state, count: "" }, handled: false };
}

// ---------------------------------------------------------------------------
// Reserved shortcuts
// ---------------------------------------------------------------------------

const VIM_BARE_CODES = new Set([
  "KeyH", "KeyJ", "KeyK", "KeyL", "KeyG", "KeyV", "KeyY", "KeyD", "KeyP", "KeyU",
  "Slash",
  "Digit0", "Digit1", "Digit2", "Digit3", "Digit4",
  "Digit5", "Digit6", "Digit7", "Digit8", "Digit9",
]);

/**
 * Shortcuts the registry must not bind while Vim mode is on — the interpreter
 * consumes them in browse context before dispatch. Used both to strip saved
 * overrides (sanitizeOverrides) and to block the recorder.
 */
export function isVimReservedShortcut(parsed: ParsedShortcut): boolean {
  if (parsed.meta || parsed.alt) return false;
  if (parsed.ctrl) return !parsed.shift && (parsed.code === "KeyR" || parsed.code === "KeyP");
  if (parsed.shift)
    // G, : (shift+;), ? (shift+/) — gt/gT need no entry: only g itself is bound.
    return parsed.code === "KeyG" || parsed.code === "Semicolon" || parsed.code === "Slash";
  return VIM_BARE_CODES.has(parsed.code);
}
