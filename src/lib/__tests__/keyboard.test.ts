import { describe, expect, it } from "vitest";
import {
  eventMatches,
  matchCommand,
  parseShortcut,
  shortcutLabel,
  type DispatchableCommand,
  type KeyLike,
} from "../keyboard";

function key(code: string, mods: Partial<KeyLike> = {}): KeyLike {
  return {
    code,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  };
}

describe("parseShortcut", () => {
  it("parses modifiers and letters", () => {
    expect(parseShortcut("cmd+shift+n")).toEqual({
      code: "KeyN", meta: true, ctrl: false, alt: false, shift: true,
    });
  });

  it("parses special keys", () => {
    expect(parseShortcut("space")?.code).toBe("Space");
    expect(parseShortcut("cmd+delete")?.code).toBe("Backspace");
    expect(parseShortcut("cmd+shift+.")?.code).toBe("Period");
    expect(parseShortcut("ctrl+tab")?.code).toBe("Tab");
    expect(parseShortcut("cmd+opt+l")?.alt).toBe(true);
    expect(parseShortcut("cmd+1")?.code).toBe("Digit1");
    expect(parseShortcut("up")?.code).toBe("ArrowUp");
  });

  it("returns null for garbage", () => {
    expect(parseShortcut("cmd+wat")).toBeNull();
    expect(parseShortcut("cmd+shift")).toBeNull();
  });
});

describe("eventMatches", () => {
  it("requires exact modifier match", () => {
    const binding = parseShortcut("cmd+c")!;
    expect(eventMatches(key("KeyC", { metaKey: true }), binding)).toBe(true);
    expect(eventMatches(key("KeyC", { metaKey: true, shiftKey: true }), binding)).toBe(false);
    expect(eventMatches(key("KeyC"), binding)).toBe(false);
  });
});

describe("matchCommand routing", () => {
  const ran: string[] = [];
  const commands: DispatchableCommand[] = [
    {
      id: "copy",
      bindings: [parseShortcut("cmd+c")!],
      contexts: ["browse"],
      run: () => ran.push("copy"),
    },
    {
      id: "closePreview",
      bindings: [parseShortcut("space")!, parseShortcut("escape")!],
      contexts: ["preview"],
      run: () => ran.push("closePreview"),
    },
    {
      id: "openPreview",
      bindings: [parseShortcut("space")!],
      contexts: ["browse"],
      run: () => ran.push("openPreview"),
    },
    {
      id: "disabledCmd",
      bindings: [parseShortcut("cmd+j")!],
      contexts: ["browse"],
      enabled: () => false,
      run: () => ran.push("disabled"),
    },
  ];

  it("routes by context: same key, different command", () => {
    const space = key("Space");
    expect(matchCommand(commands, space, "browse")?.id).toBe("openPreview");
    expect(matchCommand(commands, space, "preview")?.id).toBe("closePreview");
  });

  it("does not fire browse commands while renaming", () => {
    expect(matchCommand(commands, key("KeyC", { metaKey: true }), "rename")).toBeNull();
    expect(matchCommand(commands, key("Space"), "rename")).toBeNull();
  });

  it("supports multiple bindings per command", () => {
    expect(matchCommand(commands, key("Escape"), "preview")?.id).toBe("closePreview");
  });

  it("returns null for disabled commands", () => {
    expect(matchCommand(commands, key("KeyJ", { metaKey: true }), "browse")).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(matchCommand(commands, key("KeyQ", { metaKey: true }), "browse")).toBeNull();
  });
});

describe("shortcutLabel", () => {
  it("renders macOS symbols in canonical modifier order", () => {
    expect(shortcutLabel("cmd+shift+n")).toBe("⇧⌘N");
    expect(shortcutLabel("cmd+opt+v")).toBe("⌥⌘V");
    expect(shortcutLabel("cmd+delete")).toBe("⌘⌫");
    expect(shortcutLabel("cmd+shift+.")).toBe("⇧⌘.");
    expect(shortcutLabel("space")).toBe("Space");
  });
});
