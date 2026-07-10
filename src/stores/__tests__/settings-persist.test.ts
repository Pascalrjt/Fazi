/**
 * Settings persistence contract: the store persists at implicit version 0 —
 * a `version` key with no `migrate` would silently discard every user's
 * settings on upgrade. New keys are additive with defaults; an old blob
 * rehydrates with defaults filled in.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { SETTINGS_DEFAULTS, useSettings } from "../settings";

describe("settings persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("the persisted blob carries no version key (implicit version 0)", () => {
    useSettings.setState({ showHidden: true }); // force a write
    const raw = localStorage.getItem("fazi-settings");
    expect(raw).not.toBeNull();
    const blob = JSON.parse(raw as string) as Record<string, unknown>;
    // zustand/persist writes {state, version}; version must stay 0 —
    // bumping it without a migrate() discards existing users' settings.
    expect(blob.version ?? 0).toBe(0);
  });

  it("an old blob (pre-M5 keys) rehydrates with defaults for new keys", async () => {
    localStorage.setItem(
      "fazi-settings",
      JSON.stringify({
        state: { showHidden: true, viewMode: "grid", favorites: [{ path: "/p", name: "P" }] },
        version: 0,
      }),
    );
    await useSettings.persist.rehydrate();
    const s = useSettings.getState();
    // old values kept…
    expect(s.showHidden).toBe(true);
    expect(s.viewMode).toBe("grid");
    expect(s.favorites).toEqual([{ path: "/p", name: "P" }]);
    // …new keys filled from defaults
    expect(s.verifyCopies).toBe(SETTINGS_DEFAULTS.verifyCopies);
    expect(s.theme).toBe("system");
    expect(s.keybindingOverrides).toEqual({});
    expect(s.confirmEmptyTrash).toBe(true);
    expect(s.opCardAutoHideMs).toBe(4000);
  });

  it("resetToDefaults keeps favorites", async () => {
    useSettings.setState({
      showHidden: true,
      verifyCopies: true,
      favorites: [{ path: "/keep", name: "Keep" }],
    });
    useSettings.getState().resetToDefaults();
    const s = useSettings.getState();
    expect(s.showHidden).toBe(false);
    expect(s.verifyCopies).toBe(false);
    expect(s.favorites).toEqual([{ path: "/keep", name: "Keep" }]);
  });
});
