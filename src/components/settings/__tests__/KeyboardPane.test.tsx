import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { rebuildRegistry } from "../../../lib/commands";
import { useSettings } from "../../../stores/settings";
import { KeyboardPane } from "../KeyboardPane";

describe("KeyboardPane conflict capture", () => {
  beforeEach(() => {
    useSettings.setState({ keybindingOverrides: {} });
    rebuildRegistry({});
  });

  afterEach(cleanup);

  it("shows the conflict inline and can transfer the shortcut", () => {
    render(<KeyboardPane />);
    const title = screen.getByText("New Folder");
    const row = title.closest(".py-1\\.5");
    expect(row).toBeTruthy();
    fireEvent.click(within(row as HTMLElement).getByText("Record"));

    fireEvent.keyDown(window, { key: "d", code: "KeyD", metaKey: true });

    expect(within(row as HTMLElement).getByText("⌘D conflicts")).toBeTruthy();
    expect(within(row as HTMLElement).getByText(/taken by “Duplicate”/)).toBeTruthy();
    fireEvent.click(within(row as HTMLElement).getByText(/Unbind “Duplicate” and use it here/));

    expect(useSettings.getState().keybindingOverrides.newFolder).toEqual(["cmd+d"]);
    expect(useSettings.getState().keybindingOverrides.duplicate).toBeNull();
  });
});
