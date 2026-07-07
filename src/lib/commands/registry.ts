/**
 * Declarative command registry — the single source of truth feeding BOTH the
 * keyboard dispatcher and the cmdk command palette.
 */
import {
  matchCommand,
  parseShortcut,
  type DispatchableCommand,
  type KeyContext,
  type KeyLike,
  type ParsedShortcut,
} from "../keyboard";

export interface CommandSpec {
  id: string;
  /** Palette title, e.g. "New Folder". */
  title: string;
  /** Extra fuzzy-match words for the palette. */
  keywords?: string;
  /** Primary shortcut, e.g. "cmd+shift+n". Shown in palette + menus. */
  shortcut?: string;
  /** Additional bindings that trigger the same command. */
  extraShortcuts?: string[];
  /** Contexts where the shortcut fires. Defaults to ["browse"]. */
  context?: KeyContext[];
  /** Hide from the command palette (still keyboard-dispatchable). */
  hidden?: boolean;
  enabled?: () => boolean;
  run: () => void;
}

export interface RegisteredCommand extends CommandSpec {
  contexts: readonly KeyContext[];
  bindings: ParsedShortcut[];
}

const registry: RegisteredCommand[] = [];

export function registerCommand(spec: CommandSpec): void {
  const shortcuts = [
    ...(spec.shortcut ? [spec.shortcut] : []),
    ...(spec.extraShortcuts ?? []),
  ];
  const bindings: ParsedShortcut[] = [];
  for (const s of shortcuts) {
    const parsed = parseShortcut(s);
    if (parsed === null) {
      throw new Error(`Command "${spec.id}": unparseable shortcut "${s}"`);
    }
    bindings.push(parsed);
  }
  registry.push({
    ...spec,
    contexts: spec.context ?? ["browse"],
    bindings,
  });
}

export function registerCommands(specs: CommandSpec[]): void {
  for (const spec of specs) registerCommand(spec);
}

export function allCommands(): readonly RegisteredCommand[] {
  return registry;
}

export function getCommand(id: string): RegisteredCommand | undefined {
  return registry.find((c) => c.id === id);
}

export function runCommand(id: string): void {
  const cmd = getCommand(id);
  if (!cmd) return;
  if (cmd.enabled && !cmd.enabled()) return;
  cmd.run();
}

/** Used by the window keydown listener. */
export function dispatchKey(event: KeyLike, context: KeyContext): RegisteredCommand | null {
  const match = matchCommand(registry as DispatchableCommand[], event, context);
  return (match as RegisteredCommand | null) ?? null;
}

/** Test hook — wipe between test cases. */
export function clearRegistry(): void {
  registry.length = 0;
}

/**
 * Validation used by tests: no two commands may claim the same binding within
 * an overlapping context. Returns human-readable conflict descriptions.
 */
export function findShortcutConflicts(commands: readonly RegisteredCommand[] = registry): string[] {
  const conflicts: string[] = [];
  const seen = new Map<string, string>(); // "context|code|mods" -> command id
  for (const cmd of commands) {
    for (const b of cmd.bindings) {
      const mods = `${b.meta ? "M" : ""}${b.ctrl ? "C" : ""}${b.alt ? "A" : ""}${b.shift ? "S" : ""}`;
      for (const ctx of cmd.contexts) {
        const key = `${ctx}|${b.code}|${mods}`;
        const prev = seen.get(key);
        if (prev && prev !== cmd.id) {
          conflicts.push(`"${cmd.id}" and "${prev}" both bind ${b.code}+${mods} in context ${ctx}`);
        } else {
          seen.set(key, cmd.id);
        }
      }
    }
  }
  return conflicts;
}
