/** The single window-level keydown listener routing to the command registry. */
import { useEffect } from "react";
import { currentKeyContext } from "../lib/keyContext";
import { dispatchKey } from "../lib/commands/registry";
import {
  emptyTypeAhead,
  typeAheadPush,
  typeAheadTarget,
  type TypeAheadState,
} from "../lib/selection";
import { useApp } from "../stores/app";
import { useMenu } from "../stores/menu";
import { activePaneTab, usePanes, visibleEntries } from "../stores/panes";

let typeAhead: TypeAheadState = emptyTypeAhead();

function handleTypeAhead(e: KeyboardEvent): void {
  const app = useApp.getState();
  if (app.globalSearch.active) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key.length !== 1 || e.key === " ") return;
  const at = activePaneTab();
  if (!at) return;
  const { pane, tab } = at;
  const visible = visibleEntries(tab);
  if (visible.length === 0) return;
  typeAhead = typeAheadPush(typeAhead, e.key, performance.now());
  const idx = typeAheadTarget(
    visible.map((v) => v.name),
    typeAhead.buffer,
  );
  if (idx === -1) return;
  const id = visible[idx].id;
  usePanes.getState().setSelection(pane.id, tab.id, {
    selected: new Set([id]),
    anchor: id,
    lead: id,
  });
}

export function useKeyboard(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (useMenu.getState().open) return; // the menu owns the keyboard
      const context = currentKeyContext(e.target);
      // modal + rename contexts are fully component-handled
      if (context === "rename") {
        // RenameInput stops propagation on its own keys, so a keydown reaching
        // the window means nothing is rendering the input (view switched, row
        // scrolled out, search took the pane). Escape must always free the
        // keyboard — otherwise every key is swallowed with no way back.
        if (e.key === "Escape") useApp.getState().stopRename();
        return;
      }
      if (context === "modal") return;
      const cmd = dispatchKey(e, context);
      if (cmd) {
        e.preventDefault();
        cmd.run();
        return;
      }
      if (context === "browse") handleTypeAhead(e);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
