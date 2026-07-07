/**
 * Context-aware keyboard dispatcher.
 *
 * Shortcuts are written as "cmd+shift+n", "space", "cmd+opt+delete", …
 * Matching is done against KeyboardEvent.code (layout-stable for letters and
 * punctuation) with exact modifier comparison. One window-level keydown
 * listener routes to the command registry based on the active KeyContext.
 */

export type KeyContext = "browse" | "rename" | "palette" | "preview" | "modal" | "search";

export interface ParsedShortcut {
  code: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

const CODE_MAP: Record<string, string> = {
  enter: "Enter",
  return: "Enter",
  escape: "Escape",
  esc: "Escape",
  space: "Space",
  tab: "Tab",
  delete: "Backspace", // the Mac "delete" key
  backspace: "Backspace",
  forwarddelete: "Delete",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  ".": "Period",
  ",": "Comma",
  "/": "Slash",
  "\\": "Backslash",
  ";": "Semicolon",
  "'": "Quote",
  "[": "BracketLeft",
  "]": "BracketRight",
  "-": "Minus",
  "=": "Equal",
  "`": "Backquote",
};

/** "cmd+shift+n" → ParsedShortcut. Returns null for unparseable strings. */
export function parseShortcut(shortcut: string): ParsedShortcut | null {
  const parts = shortcut.toLowerCase().split("+");
  const parsed: ParsedShortcut = { code: "", meta: false, ctrl: false, alt: false, shift: false };
  for (const raw of parts) {
    const part = raw.trim();
    switch (part) {
      case "cmd":
      case "meta":
        parsed.meta = true;
        break;
      case "ctrl":
        parsed.ctrl = true;
        break;
      case "opt":
      case "alt":
        parsed.alt = true;
        break;
      case "shift":
        parsed.shift = true;
        break;
      default: {
        if (CODE_MAP[part]) parsed.code = CODE_MAP[part];
        else if (/^[a-z]$/.test(part)) parsed.code = `Key${part.toUpperCase()}`;
        else if (/^[0-9]$/.test(part)) parsed.code = `Digit${part}`;
        else if (/^f([1-9]|1[0-9])$/.test(part)) parsed.code = part.toUpperCase();
        else return null;
      }
    }
  }
  if (parsed.code === "") return null;
  return parsed;
}

export interface KeyLike {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export function eventMatches(event: KeyLike, parsed: ParsedShortcut): boolean {
  return (
    event.code === parsed.code &&
    event.metaKey === parsed.meta &&
    event.ctrlKey === parsed.ctrl &&
    event.altKey === parsed.alt &&
    event.shiftKey === parsed.shift
  );
}

/** Pretty symbols for menus/palette: "cmd+shift+n" → "⇧⌘N". */
export function shortcutLabel(shortcut: string): string {
  const parsed = parseShortcut(shortcut);
  if (!parsed) return "";
  let label = "";
  if (parsed.ctrl) label += "⌃";
  if (parsed.alt) label += "⌥";
  if (parsed.shift) label += "⇧";
  if (parsed.meta) label += "⌘";
  const code = parsed.code;
  const KEY_LABELS: Record<string, string> = {
    Enter: "↩", Escape: "⎋", Space: "Space", Tab: "⇥",
    Backspace: "⌫", Delete: "⌦",
    ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
    Period: ".", Comma: ",", Slash: "/", Backslash: "\\",
    Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]",
    Minus: "-", Equal: "=", Backquote: "`",
  };
  if (KEY_LABELS[code]) label += KEY_LABELS[code];
  else if (code.startsWith("Key")) label += code.slice(3);
  else if (code.startsWith("Digit")) label += code.slice(5);
  else label += code;
  return label;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export interface DispatchableCommand {
  id: string;
  /** Parsed bindings (a command may have several). */
  bindings: ParsedShortcut[];
  /** Contexts in which the binding fires. */
  contexts: readonly KeyContext[];
  enabled?: () => boolean;
  run: () => void;
}

/**
 * Find the first matching enabled command for an event in the given context.
 * Pure — the caller decides preventDefault/run.
 */
export function matchCommand(
  commands: readonly DispatchableCommand[],
  event: KeyLike,
  context: KeyContext,
): DispatchableCommand | null {
  for (const cmd of commands) {
    if (!cmd.contexts.includes(context)) continue;
    for (const binding of cmd.bindings) {
      if (eventMatches(event, binding)) {
        if (cmd.enabled && !cmd.enabled()) return null; // matched but disabled: swallow nothing
        return cmd;
      }
    }
  }
  return null;
}
