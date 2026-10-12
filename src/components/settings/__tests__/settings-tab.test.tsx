import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SettingsOverlay } from "../SettingsOverlay";
import { useApp } from "../../../stores/app";
import { SETTINGS_DEFAULTS, useSettings } from "../../../stores/settings";

describe("Settings appearance", () => {
  beforeEach(() => {
    useApp.setState({ settingsOpen: true });
    useSettings.setState(SETTINGS_DEFAULTS);
  });

  afterEach(() => {
    cleanup();
    useApp.setState({ settingsOpen: false });
  });

  it("keeps the Default swatch tied to the built-in accent", () => {
    render(<SettingsOverlay />);
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));

    const defaultSwatch = screen.getByRole("button", { name: "Default" });
    expect(defaultSwatch.style.background).toBe("rgb(79, 142, 247)");

    fireEvent.click(screen.getByRole("button", { name: "Green" }));

    expect(useSettings.getState().accent).toBe("#4fa356");
    expect(defaultSwatch.style.background).toBe("rgb(79, 142, 247)");
  });
});
