import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { SettingsTab, SettingsTabRow } from "../SettingsTab";
import { rebuildRegistry } from "../../../lib/commands";
import { useApp } from "../../../stores/app";
import { SETTINGS_DEFAULTS, useSettings } from "../../../stores/settings";

function openAt(section: Parameters<ReturnType<typeof useApp.getState>["openSettingsPane"]>[0]) {
  useApp.getState().openSettingsPane(section);
}

describe("Settings tab", () => {
  beforeEach(() => {
    useSettings.setState({ ...SETTINGS_DEFAULTS, favorites: [], cleanupKept: [] });
    rebuildRegistry({});
    openAt("general");
  });

  afterEach(() => {
    cleanup();
    useApp.getState().setSettingsOpen(false);
  });

  it("keeps the Default swatch tied to the built-in accent", () => {
    openAt("appearance");
    render(<SettingsTab />);
    const defaultSwatch = screen.getByRole("radio", { name: "Default" });
    expect(defaultSwatch.style.background).toBe("var(--accent-default)");

    fireEvent.click(screen.getByRole("radio", { name: "Green" }));

    expect(useSettings.getState().accent).toBe("#4fa356");
    expect(defaultSwatch.style.background).toBe("var(--accent-default)");
  });

  it("marks a changed setting and restores its default", () => {
    render(<SettingsTab />);
    expect(screen.queryByTitle("Changed from default")).toBeNull();

    fireEvent.click(screen.getByRole("switch", { name: "Show folder sizes" }));
    expect(useSettings.getState().showFolderSizes).toBe(true);
    expect(screen.getByTitle("Changed from default")).toBeTruthy();
    // The section bar counts it.
    expect(within(screen.getByRole("navigation", { name: "Settings sections" })).getByTitle("1 changed")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Restore default for Show folder sizes" }));
    expect(useSettings.getState().showFolderSizes).toBe(false);
    expect(screen.queryByTitle("Changed from default")).toBeNull();
  });

  it("asks before resetting everything and keeps pinned folders", () => {
    useSettings.setState({
      zebraStripes: false,
      favorites: [{ path: "/Users/me/Projects", name: "Projects" }],
    });
    openAt("reset");
    render(<SettingsTab />);

    fireEvent.click(screen.getByRole("button", { name: "Reset 1 changed setting…" }));
    expect(useSettings.getState().zebraStripes).toBe(false); // nothing yet
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Reset" }));

    expect(useSettings.getState().zebraStripes).toBe(true);
    expect(useSettings.getState().favorites).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Everything is at its default" })).toHaveProperty("disabled", true);
  });

  it("searches every section, including shortcut names", () => {
    useApp.getState().setSettingsQuery("trash");
    render(<SettingsTab />);
    expect(screen.getByText("Ask before emptying the Trash")).toBeTruthy();
    expect(screen.getByText("Show Trash in sidebar")).toBeTruthy();
    expect(screen.getByText("Move to Trash")).toBeTruthy(); // a command
    expect(screen.queryByText("Theme")).toBeNull();
  });

  it("finds settings by synonyms", () => {
    useApp.getState().setSettingsQuery("dotfiles");
    render(<SettingsTab />);
    expect(screen.getByText("Show hidden files")).toBeTruthy();
  });

  it("closes from its tab row", () => {
    render(<SettingsTabRow />);
    fireEvent.click(screen.getByRole("button", { name: "Close Settings" }));
    expect(useApp.getState().settingsOpen).toBe(false);
    expect(useApp.getState().settingsActive).toBe(false);
  });

  it("switches back to the panes without closing when another tab is chosen", () => {
    useApp.getState().setSettingsActive(false);
    expect(useApp.getState().settingsOpen).toBe(true);
    render(<SettingsTabRow />);
    fireEvent.click(screen.getByRole("tab", { name: /Settings/ }));
    expect(useApp.getState().settingsActive).toBe(true);
  });
});
