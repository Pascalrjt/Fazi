import { beforeEach, describe, expect, it } from "vitest";
import {
  allCommands,
  clearRegistry,
  findShortcutConflicts,
  registerCommand,
} from "../commands/registry";
import { registerAllCommands } from "../commands";

describe("registry mechanics", () => {
  beforeEach(() => clearRegistry());

  it("parses shortcuts at registration and rejects garbage", () => {
    expect(() =>
      registerCommand({ id: "bad", title: "Bad", shortcut: "cmd+nope", run: () => {} }),
    ).toThrow(/unparseable/);
  });

  it("detects duplicate shortcuts within the same context", () => {
    registerCommand({ id: "a", title: "A", shortcut: "cmd+j", run: () => {} });
    registerCommand({ id: "b", title: "B", shortcut: "cmd+j", run: () => {} });
    const conflicts = findShortcutConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toContain('"b"');
    expect(conflicts[0]).toContain('"a"');
  });

  it("allows the same shortcut in different contexts", () => {
    registerCommand({ id: "a", title: "A", shortcut: "space", context: ["browse"], run: () => {} });
    registerCommand({ id: "b", title: "B", shortcut: "space", context: ["preview"], run: () => {} });
    expect(findShortcutConflicts()).toHaveLength(0);
  });
});

describe("the real command set", () => {
  it("registers without errors and has no duplicate shortcuts in any context", () => {
    clearRegistry();
    // re-registration guard is module-level; call the internal register path
    registerAllCommands();
    const commands = allCommands();
    expect(commands.length).toBeGreaterThan(30);
    expect(findShortcutConflicts(commands)).toEqual([]);
  });

  it("every command has a unique id", () => {
    const ids = allCommands().map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("core Finder-parity bindings are present", () => {
    const byId = new Map(allCommands().map((c) => [c.id, c]));
    expect(byId.get("trash")?.shortcut).toBe("cmd+delete");
    expect(byId.get("movePaste")?.shortcut).toBe("cmd+opt+v");
    expect(byId.get("preview")?.shortcut).toBe("space");
    expect(byId.get("toggleHidden")?.shortcut).toBe("cmd+shift+.");
    expect(byId.get("palette")?.shortcut).toBe("cmd+k");
    expect(byId.get("dualPane")?.shortcut).toBe("cmd+shift+d");
    expect(byId.get("swapPane")?.shortcut).toBe("tab");
    expect(byId.get("newFolder")?.shortcut).toBe("cmd+shift+n");
    expect(byId.get("openLocation")?.shortcut).toBe("cmd+shift+g");
  });
});
