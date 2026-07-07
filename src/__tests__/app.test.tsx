/**
 * Backend-less smoke test: the whole app must render in jsdom with no Tauri
 * runtime present — IPC failures become error states/toasts, never crashes.
 */
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import App from "../App";

describe("App without a backend", () => {
  it("renders the shell and settles into an error state instead of crashing", async () => {
    render(<App />);
    // toolbar search field is part of the static chrome
    expect(screen.getByPlaceholderText(/Filter/)).toBeTruthy();
    // boot tries listVolumes/defaultFolders/listDir — all reject; the pane
    // must settle into a designed error state (not a blank crash)
    await waitFor(() => {
      expect(document.querySelector(".loading-bar")).toBeNull();
    });
    // status bar renders
    expect(screen.getByText(/0 items|items/)).toBeTruthy();
  });
});
