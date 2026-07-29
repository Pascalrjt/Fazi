/**
 * The `fazi://menu` handler.
 *
 * The native macOS Edit menu owns ⌘Z/⌘⇧Z/⌘X/⌘C/⌘V/⌘A as key equivalents, and
 * AppKit consumes a key equivalent BEFORE the focused webview control sees it.
 * So a keystroke aimed at a text field never produces a DOM keydown — it
 * arrives here instead, with no context attached. Two things follow:
 *
 *  1. This path must re-apply the filter `matchCommand` applies to keystrokes,
 *     or file commands fire behind modals and inside text fields (⌘V during a
 *     rename used to create a new document).
 *  2. When a text field does own focus, nothing else will perform the edit, so
 *     it is done here against the focused element.
 *
 * The same handler covers Edit ▸ Paste clicked with the mouse, which never
 * blurs the field and so cannot be fixed by suppressing accelerators.
 */
import { getCommand, runCommand } from "./registry";
import { currentKeyContext } from "../keyContext";
import type { KeyContext } from "../keyboard";
import * as ipc from "../ipc";

/**
 * Input types where selection-based editing is meaningful. `number`,
 * `checkbox`, and `radio` don't support selectionStart in WebKit (reading it
 * throws), and there is no contentEditable anywhere in the app.
 */
const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel", "password", "email"]);

export type TextTarget = HTMLInputElement | HTMLTextAreaElement;

/** The focused element, if it's a field we can edit. */
export function textEditTarget(el: Element | null): TextTarget | null {
  if (el instanceof HTMLTextAreaElement) return el;
  if (el instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(el.type.toLowerCase())) return el;
  return null;
}

export type MenuAction =
  | { kind: "text"; commandId: string } // a text field owns focus
  | { kind: "file"; commandId: string } // run the registry command
  | { kind: "ignore" }; // wrong context — swallow

/**
 * Pure decision: what should this menu item do right now?
 *
 * The context test reuses each command's DECLARED `contexts` rather than a
 * hand-written allowlist, so the menu path and the keyboard path can never
 * drift. All six Edit commands are ["browse"], so ⌘Z behind Settings, the
 * palette, or a preview is correctly swallowed.
 */
export function menuCommandAction(
  commandId: string,
  context: KeyContext,
  hasTextTarget: boolean,
): MenuAction {
  if (hasTextTarget) return { kind: "text", commandId };
  const cmd = getCommand(commandId);
  if (!cmd) return { kind: "ignore" };
  return cmd.contexts.includes(context) ? { kind: "file", commandId } : { kind: "ignore" };
}

/**
 * Perform the edit on the focused field.
 *
 * execCommand is deprecated but is the right mechanism here: it fires an
 * `input` event (so React's onChange sees the change — assigning `.value`
 * directly would not) and it preserves the field's native undo stack.
 */
async function applyTextEdit(commandId: string, el: TextTarget): Promise<void> {
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? 0;
  switch (commandId) {
    case "selectAll":
      el.select();
      return;
    case "copy":
    case "cut": {
      if (start === end) return; // empty selection must never clobber the pasteboard
      // Write first: a failed pasteboard write must not lose the text.
      await ipc.pbWriteText(el.value.slice(start, end));
      if (commandId === "cut") document.execCommand("delete");
      return;
    }
    case "paste": {
      const text = await ipc.pbReadText();
      if (text == null || text === "") return;
      // Focus/selection can move during the IPC round trip — restore both
      // before inserting, or the text lands somewhere unexpected.
      if (document.activeElement !== el) el.focus();
      if (el.selectionStart !== start || el.selectionEnd !== end) {
        el.setSelectionRange(start, end);
      }
      document.execCommand("insertText", false, text);
      return;
    }
    case "undo":
      document.execCommand("undo");
      return;
    case "redo":
      document.execCommand("redo");
      return;
  }
}

export function runMenuCommand(commandId: string): void {
  const target = textEditTarget(document.activeElement);
  const action = menuCommandAction(commandId, currentKeyContext(target), target !== null);
  if (action.kind === "ignore") return;
  if (action.kind === "file") {
    runCommand(action.commandId);
    return;
  }
  void applyTextEdit(action.commandId, target as TextTarget).catch(() => {
    // No backend (browser-only preview/tests) or an unreadable pasteboard —
    // dropping the edit is correct; the destructive path stays unreachable.
  });
}
