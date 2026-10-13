import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { rebuildRegistry } from "../../../lib/commands";
import { useSettings } from "../../../stores/settings";
import { KeyboardPane } from "../KeyboardPane";

function rowOf(commandId: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-command-id="${commandId}"]`);
  expect(row).toBeTruthy();
  return row as HTMLElement;
}

describe("KeyboardPane", () => {
  beforeEach(() => {
    useSettings.setState({ keybindingOverrides: {}, vimMode: false });
    rebuildRegistry({});
  });

  afterEach(cleanup);

  it("shows the conflict inline and can move the shortcut", () => {
    render(<KeyboardPane />);
    const row = rowOf("newFolder");
    fireEvent.click(within(row).getByRole("button", { name: "Change the shortcut for New Folder" }));

    fireEvent.keyDown(window, { key: "d", code: "KeyD", metaKey: true });

    expect(within(row).getByRole("alert").textContent).toContain("already runs “Duplicate”");
    fireEvent.click(within(row).getByRole("button", { name: "Move it here" }));

    expect(useSettings.getState().keybindingOverrides.newFolder).toEqual(["cmd+d"]);
    expect(useSettings.getState().keybindingOverrides.duplicate).toBeNull();
  });

  it("blocks Vim's keys while Vim mode is on", () => {
    useSettings.setState({ vimMode: true });
    rebuildRegistry({});
    render(<KeyboardPane />);
    const row = rowOf("newFolder");
    fireEvent.click(within(row).getByRole("button", { name: "Change the shortcut for New Folder" }));
    fireEvent.keyDown(window, { key: "j", code: "KeyJ" });
    expect(within(row).getByRole("alert").textContent).toContain("j belongs to Vim mode");
    expect(useSettings.getState().keybindingOverrides.newFolder).toBeUndefined();
  });

  it("filters shortcuts by area and by keys", () => {
    render(<KeyboardPane />);
    const filter = screen.getByRole("textbox", { name: "Filter shortcuts" });
    fireEvent.change(filter, { target: { value: "tabs and panes" } });
    expect(document.querySelector('[data-command-id="newTab"]')).toBeTruthy();
    expect(document.querySelector('[data-command-id="copy"]')).toBeNull();

    fireEvent.change(filter, { target: { value: "⌘D" } });
    expect(document.querySelector('[data-command-id="duplicate"]')).toBeTruthy();
    expect(document.querySelector('[data-command-id="newTab"]')).toBeNull();
  });
});
