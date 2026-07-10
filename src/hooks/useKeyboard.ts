/** The single window-level keydown listener routing to the command registry. */
import { useEffect } from "react";
import type { KeyContext } from "../lib/keyboard";
import { dispatchKey } from "../lib/commands/registry";
import {
  emptyTypeAhead,
  typeAheadPush,
  typeAheadTarget,
  type TypeAheadState,
} from "../lib/selection";
import { useApp } from "../stores/app";
import { useFuzzy } from "../stores/fuzzy";
import { useOps } from "../stores/ops";
import { useMenu } from "../stores/menu";
import { activePaneTab, usePanes, visibleEntries } from "../stores/panes";

let typeAhead: TypeAheadState = emptyTypeAhead();

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}

export function currentKeyContext(target: EventTarget | null = null): KeyContext {
  const app = useApp.getState();
  const ops = useOps.getState();
  if (app.confirm || ops.conflicts.length > 0) return "modal";
  if (app.paletteOpen || useFuzzy.getState().open) return "palette";
  if (app.renaming) return "rename";
  if (app.previewOpen) return "preview";
  if (app.searchFieldFocused || app.pathBarEditing || isEditableTarget(target)) return "search";
  return "browse";
}

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
      if (context === "modal" || context === "rename") return;
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
