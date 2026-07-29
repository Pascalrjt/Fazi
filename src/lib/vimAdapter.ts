/**
 * Impure side of Vim mode: feeds keydowns through the pure reducer
 * (lib/vim.ts) and executes the resulting actions against the command
 * registry and the semantic navigation verbs in lib/commands.
 *
 * Only the window keydown listener calls handleVimKey, and only in browse
 * context with global search inactive — search results own their local
 * selection (capture-phase listeners), and a Vim motion here would move the
 * hidden directory selection underneath them.
 */
import { nextVimState, type VimAction } from "./vim";
import { useVim } from "../stores/vim";
import { runCommand } from "./commands/registry";
import {
  collapseSelectionToLead,
  ensureLead,
  moveLeadBy,
  moveLeadToEdge,
} from "./commands";
import { activePaneTab, usePanes } from "../stores/panes";
import { useApp } from "../stores/app";
import { cycleBrowseSurface, openKeyboardContextMenu } from "./keyboardFocus";

/** Returns true when Vim consumed the key (caller must preventDefault). */
export function handleVimKey(e: KeyboardEvent): boolean {
  if (e.isComposing || e.key === "Dead" || e.key === "Process" || e.key === "Unidentified")
    return false;
  // A modifier going down is not a key: Shift precedes ?, G, and gT, and must
  // not cancel a pending prefix or count as an unknown continuation.
  if (e.key === "Shift" || e.key === "CapsLock") return false;
  if (e.metaKey || e.altKey) {
    // A chord command is coming — stale prefixes must not resume after it.
    resetVimTransient();
    return false;
  }
  const vim = useVim.getState();
  const step = nextVimState(vim.state, { key: e.key, ctrl: e.ctrlKey });
  vim.set(step.state);
  if (step.action) runVimAction(step.action);
  return step.handled;
}

function runVimAction(action: VimAction): void {
  switch (action.kind) {
    case "move":
      moveLeadBy(action.dir, action.extend, action.count);
      break;
    case "edge":
      moveLeadToEdge(action.edge, action.extend);
      break;
    case "enterVisual":
      ensureLead();
      break;
    case "exitVisual":
      collapseSelectionToLead();
      break;
    // Everything else routes through the registry so enabled() guards and
    // the commands' own logic apply exactly as for their ⌘ shortcuts.
    case "openParent":
      runCommand("up");
      break;
    case "open":
      runCommand("open");
      break;
    case "focusFilter":
      runCommand("focusSearch");
      break;
    case "openPalette":
      runCommand("palette");
      break;
    case "openFuzzy":
      runCommand("fuzzyFinder");
      break;
    case "openGlobalSearch":
      runCommand("globalSearch");
      break;
    case "nextTab":
      runCommand("nextTab");
      break;
    case "prevTab":
      runCommand("prevTab");
      break;
    case "copy":
      runCommand("copy");
      break;
    case "cut":
      runCommand("cut");
      break;
    case "paste":
      runCommand("paste");
      break;
    case "undo":
      runCommand("undo");
      break;
    case "redo":
      runCommand("redo");
      break;
    case "openContextMenu":
      openKeyboardContextMenu();
      break;
    case "cycleBrowseSurface":
      cycleBrowseSurface();
      break;
    case "openHelp":
      runCommand("vimHelp");
      break;
  }
}

/** Drop pending prefix/count and exit visual; the selection is untouched. */
export function resetVimTransient(): void {
  const { state, reset } = useVim.getState();
  if (state.mode !== "normal" || state.pending !== null || state.count !== "") reset();
}

// A pending `g` or visual range must not survive into a different pane, tab,
// or directory (Escape and unrecognized keys handle everything in-listing).
let lastTabKey: string | null = null;

function checkActiveTab(): void {
  const at = activePaneTab();
  const key = at ? `${at.pane.id}|${at.tab.id}|${at.tab.path}` : null;
  if (key !== lastTabKey) {
    lastTabKey = key;
    resetVimTransient();
  }
}

usePanes.subscribe(checkActiveTab);
useApp.subscribe((s, prev) => {
  if (s.activePaneId !== prev.activePaneId) checkActiveTab();
});
