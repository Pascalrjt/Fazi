import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ContextMenuHost } from "../ContextMenu";
import { showMenu, useMenu } from "../../../stores/menu";
import { useSettings } from "../../../stores/settings";

afterEach(() => {
  cleanup();
  useMenu.getState().close();
  useSettings.setState({ vimMode: false });
});

describe("context menu keyboard navigation", () => {
  it("uses Vim motions, returns from a submenu, and activates the selected item", () => {
    const action = vi.fn();
    useSettings.setState({ vimMode: true });
    render(
      <>
        <div data-vim-surface="pane" data-pane-id="left" tabIndex={-1} />
        <ContextMenuHost />
      </>,
    );
    const pane = document.querySelector<HTMLElement>('[data-vim-surface="pane"]')!;
    pane.focus();
    act(() => {
      showMenu(20, 20, [
        {
          type: "item",
          label: "Parent",
          submenu: [{ type: "item", label: "Child", action: vi.fn() }],
        },
        { type: "separator" },
        { type: "item", label: "Leaf", action },
      ]);
    });

    fireEvent.keyDown(document.activeElement as Element, { key: "l", code: "KeyL" });
    expect(screen.getByText("Child")).toBeTruthy();

    fireEvent.keyDown(document.activeElement as Element, { key: "h", code: "KeyH" });
    expect(screen.queryByText("Child")).toBeNull();

    fireEvent.keyDown(document.activeElement as Element, { key: "j", code: "KeyJ" });
    fireEvent.keyDown(document.activeElement as Element, { key: "Enter", code: "Enter" });
    expect(action).toHaveBeenCalledOnce();
    expect(useMenu.getState().open).toBeNull();
    expect(document.activeElement).toBe(pane);
  });
});
