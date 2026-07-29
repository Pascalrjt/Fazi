/** Cheat-sheet card: renders from app state, Escape closes it. */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { VimCheatSheet } from "../VimCheatSheet";
import { useApp } from "../../../stores/app";

afterEach(() => {
  cleanup();
  useApp.setState({ vimHelpOpen: false });
});

describe("VimCheatSheet", () => {
  it("renders nothing while closed", () => {
    render(<VimCheatSheet />);
    expect(screen.queryByText("command palette")).toBeNull();
  });

  it("lists the bindings while open", () => {
    useApp.setState({ vimHelpOpen: true });
    render(<VimCheatSheet />);
    expect(screen.getByText("j / k")).toBeTruthy();
    expect(screen.getByText("gt / gT")).toBeTruthy();
    expect(screen.getByText("command palette")).toBeTruthy();
  });

  it("Escape closes it", () => {
    useApp.setState({ vimHelpOpen: true });
    render(<VimCheatSheet />);
    fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
    expect(useApp.getState().vimHelpOpen).toBe(false);
  });

  it("clicks on the card don't close it — it's a reference, not a dialog", () => {
    useApp.setState({ vimHelpOpen: true });
    render(<VimCheatSheet />);
    fireEvent.mouseDown(screen.getByText("j / k"));
    expect(useApp.getState().vimHelpOpen).toBe(true);
  });
});
