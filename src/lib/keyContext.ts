/**
 * Which surface currently owns the keyboard.
 *
 * Lives in lib/ rather than the hook because BOTH keyboard paths need it: the
 * window keydown listener (hooks/useKeyboard.ts) and the native macOS Edit
 * menu (lib/commands/menuCommand.ts). AppKit fires menu items regardless of
 * what has focus, so the menu path has to re-apply the same filter.
 */
import type { KeyContext } from "./keyboard";
import { useApp } from "../stores/app";
import { useFuzzy } from "../stores/fuzzy";
import { useOps } from "../stores/ops";

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}

export function currentKeyContext(target: EventTarget | null = null): KeyContext {
  const app = useApp.getState();
  const ops = useOps.getState();
  if (app.confirm || app.settingsOpen || app.batchRenameOpen || ops.conflicts.length > 0)
    return "modal";
  if (app.paletteOpen || useFuzzy.getState().open) return "palette";
  if (app.renaming) return "rename";
  if (app.previewOpen) return "preview";
  if (app.searchFieldFocused || app.pathBarEditing || isEditableTarget(target)) return "search";
  return "browse";
}
