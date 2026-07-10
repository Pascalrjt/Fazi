/**
 * Keybinding overrides: replace/unbind/label reflection through a registry
 * rebuild, corrupt-blob resilience, prospective conflict detection,
 * shortcutFromEvent table, and rebuild idempotence after the guard reset.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  conflictsForOverrides,
  rebuildRegistry,
  sanitizeOverrides,
} from "../commands";
import { allCommands, clearRegistry, dispatchKey } from "../commands/registry";
import { shortcutFromEvent } from "../keyboard";

function key(code: string, mods: Partial<{ meta: boolean; ctrl: boolean; alt: boolean; shift: boolean }> = {}) {
  return {
    code,
    metaKey: mods.meta ?? false,
    ctrlKey: mods.ctrl ?? false,
    altKey: mods.alt ?? false,
    shiftKey: mods.shift ?? false,
  };
}

describe("keybinding overrides", () => {
  afterEach(() => {
    rebuildRegistry(); // restore defaults for other tests
  });

  it("an override replaces the binding AND the palette label", () => {
    rebuildRegistry({ newFolder: ["cmd+shift+m"] });
    const cmd = allCommands().find((c) => c.id === "newFolder");
    expect(cmd?.shortcut).toBe("cmd+shift+m"); // label reflection
    // Dispatches on the new binding…
    expect(dispatchKey(key("KeyM", { meta: true, shift: true }), "browse")?.id).toBe("newFolder");
    // …and no longer on the default.
    expect(dispatchKey(key("KeyN", { meta: true, shift: true }), "browse")).toBeNull();
  });

  it("null unbinds a command entirely", () => {
    rebuildRegistry({ newFolder: null });
    const cmd = allCommands().find((c) => c.id === "newFolder");
    expect(cmd?.shortcut).toBeUndefined();
    expect(cmd?.bindings).toHaveLength(0);
    expect(dispatchKey(key("KeyN", { meta: true, shift: true }), "browse")).toBeNull();
  });

  it("rebuild after the guard reset is idempotent", () => {
    rebuildRegistry();
    const count = allCommands().length;
    rebuildRegistry();
    rebuildRegistry();
    expect(allCommands().length).toBe(count); // never doubles
    const ids = allCommands().map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("corrupt overrides never prevent startup — defaults win, no throw", () => {
    const corrupt = {
      newFolder: ["cmd+notakey"], // unparseable → dropped
      nonsenseCommand: ["cmd+j"], // unknown id → dropped
      rename: 42, // wrong type → dropped
      trash: null, // valid unbind survives
    } as unknown as Record<string, string[] | null>;
    expect(() => rebuildRegistry(corrupt)).not.toThrow();
    const byId = new Map(allCommands().map((c) => [c.id, c]));
    expect(byId.get("newFolder")?.shortcut).toBe("cmd+shift+n"); // default kept
    expect(byId.get("trash")?.shortcut).toBeUndefined(); // unbind applied
    expect(byId.has("nonsenseCommand")).toBe(false);
  });

  it("sanitizeOverrides drops garbage shapes wholesale", () => {
    expect(sanitizeOverrides(null)).toEqual({});
    expect(sanitizeOverrides("junk")).toEqual({});
    expect(sanitizeOverrides([1, 2])).toEqual({});
    expect(sanitizeOverrides({ newFolder: ["cmd+shift+m", "bogus+key"] })).toEqual({
      newFolder: ["cmd+shift+m"],
    });
  });

  it("prospective conflicts are detected without touching the live registry", () => {
    clearRegistry();
    rebuildRegistry();
    const before = allCommands().find((c) => c.id === "newFolder")?.shortcut;
    // cmd+d belongs to duplicate — binding newFolder to it must conflict.
    const conflicts = conflictsForOverrides({ newFolder: ["cmd+d"] });
    expect(conflicts.some((c) => c.includes('"newFolder"') && c.includes('"duplicate"'))).toBe(
      true,
    );
    // Live registry untouched by the check.
    expect(allCommands().find((c) => c.id === "newFolder")?.shortcut).toBe(before);
    // A free shortcut has no conflicts.
    expect(conflictsForOverrides({ newFolder: ["cmd+shift+m"] })).toEqual([]);
  });
});

describe("shortcutFromEvent", () => {
  it("builds canonical shortcut strings", () => {
    expect(shortcutFromEvent(key("KeyN", { meta: true, shift: true }))).toBe("cmd+shift+n");
    expect(shortcutFromEvent(key("Digit2", { meta: true }))).toBe("cmd+2");
    expect(shortcutFromEvent(key("Enter"))).toBe("enter");
    expect(shortcutFromEvent(key("Backspace", { meta: true }))).toBe("cmd+delete");
    expect(shortcutFromEvent(key("Period", { meta: true, shift: true }))).toBe("cmd+shift+.");
    expect(shortcutFromEvent(key("F5"))).toBe("f5");
    expect(shortcutFromEvent(key("Comma", { meta: true }))).toBe("cmd+,");
    expect(shortcutFromEvent(key("ArrowDown", { alt: true }))).toBe("opt+down");
  });

  it("ignores lone modifiers and unmappable keys", () => {
    expect(shortcutFromEvent(key("MetaLeft", { meta: true }))).toBeNull();
    expect(shortcutFromEvent(key("ShiftRight", { shift: true }))).toBeNull();
    expect(shortcutFromEvent(key("AltLeft", { alt: true }))).toBeNull();
    expect(shortcutFromEvent(key("ControlLeft", { ctrl: true }))).toBeNull();
    expect(shortcutFromEvent(key("CapsLock"))).toBeNull();
    expect(shortcutFromEvent(key("MediaPlayPause"))).toBeNull();
  });

  it("round-trips through parseShortcut", async () => {
    const { parseShortcut } = await import("../keyboard");
    for (const ev of [
      key("KeyA", { meta: true }),
      key("Space"),
      key("BracketLeft", { meta: true }),
      key("Tab", { ctrl: true, shift: true }),
    ]) {
      const s = shortcutFromEvent(ev);
      expect(s).not.toBeNull();
      const parsed = parseShortcut(s as string);
      expect(parsed).not.toBeNull();
      expect(parsed?.code).toBe(ev.code);
      expect(parsed?.meta).toBe(ev.metaKey);
      expect(parsed?.shift).toBe(ev.shiftKey);
    }
  });
});
