/** Fazi application shell: layout grid, boot sequence, global overlays. */
import { useEffect } from "react";
import { rebuildRegistry, registerAllCommands } from "./lib/commands";
import { runCommand } from "./lib/commands/registry";
import { useSettings } from "./stores/settings";
import { useKeyboard } from "./hooks/useKeyboard";
import * as ipc from "./lib/ipc";
import { setupFinderDragIn } from "./lib/ipc/dnd";
import { setAltDuringDrag } from "./lib/dnd";
import { usePanes } from "./stores/panes";
import { useVolumes } from "./stores/volumes";
import { useApp } from "./stores/app";
import { pluralize } from "./lib/format";
import { Toolbar } from "./components/chrome/Toolbar";
import { StatusBar } from "./components/chrome/StatusBar";
import { Toasts } from "./components/chrome/Toasts";
import { FdaBanner } from "./components/chrome/FdaBanner";
import { ConfirmDialog } from "./components/chrome/ConfirmDialog";
import { Sidebar } from "./components/sidebar/Sidebar";
import { PaneArea } from "./components/panes/PaneArea";
import { GetInfoPanel } from "./components/info/GetInfoPanel";
import { SettingsOverlay } from "./components/settings/SettingsOverlay";
import { OpCards } from "./components/ops/OpCards";
import { ConflictDialog } from "./components/ops/ConflictDialog";
import { CommandPalette } from "./components/palette/CommandPalette";
import { FuzzyFinder } from "./components/overlays/FuzzyFinder";
import { PreviewOverlay } from "./components/preview/PreviewOverlay";
import { ContextMenuHost } from "./components/menus/ContextMenu";

registerAllCommands(useSettings.getState().keybindingOverrides);

// Keybinding overrides re-register the whole command set (labels, menus, and
// dispatch all read the registry).
useSettings.subscribe((s, prev) => {
  if (s.keybindingOverrides !== prev.keybindingOverrides) {
    rebuildRegistry(s.keybindingOverrides);
  }
});

/** Apply theme + accent to the document root. */
function applyAppearance(theme: string, accent: string): void {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") root.dataset.theme = theme;
  else delete root.dataset.theme;
  if (accent !== "") {
    root.style.setProperty("--accent", accent);
    root.style.setProperty("--accent-dim", `color-mix(in srgb, ${accent} 26%, transparent)`);
    root.style.setProperty("--accent-faint", `color-mix(in srgb, ${accent} 12%, transparent)`);
  } else {
    root.style.removeProperty("--accent");
    root.style.removeProperty("--accent-dim");
    root.style.removeProperty("--accent-faint");
  }
}

let booted = false;

function boot(): void {
  if (booted) return;
  booted = true;

  void (async () => {
    // volumes + default folders (also subscribes to mount/unmount broadcasts)
    const volumes = useVolumes.getState();
    await volumes.init();
    const home = useVolumes.getState().folders?.home ?? "/";
    usePanes.getState().boot(home);

    // journal recovery report
    try {
      const interrupted = await ipc.interruptedOps();
      for (const op of interrupted) {
        const kind = op.kind.charAt(0).toUpperCase() + op.kind.slice(1);
        useApp
          .getState()
          .pushToast(
            `${kind} interrupted — ${op.completed} of ${pluralize(op.total, "item")} completed`,
            { sticky: true },
          );
      }
    } catch {
      // no backend / no journal — nothing to report
    }
  })();
}

export default function App() {
  useKeyboard();
  const theme = useSettings((s) => s.theme);
  const accent = useSettings((s) => s.accent);

  useEffect(() => {
    applyAppearance(theme, accent);
  }, [theme, accent]);

  useEffect(() => {
    boot();
    let alive = true;
    let unlistenDnd: (() => void) | undefined;
    let unlistenMenu: (() => void) | undefined;
    void setupFinderDragIn().then((fn) => {
      if (alive) unlistenDnd = fn;
      else fn();
    });
    ipc
      .onMenuCommand((commandId) => runCommand(commandId))
      .then((fn) => {
        if (alive) unlistenMenu = fn;
        else fn();
      })
      .catch(() => {});
    // ⌥ tracker for native drag-out: the dragstart snapshot covers
    // press-then-drag; these keep mid-drag presses/releases current while the
    // window still receives key events.
    const onAltKey = (e: KeyboardEvent) => {
      if (e.key === "Alt") setAltDuringDrag(e.type === "keydown");
    };
    window.addEventListener("keydown", onAltKey);
    window.addEventListener("keyup", onAltKey);
    return () => {
      alive = false;
      unlistenDnd?.();
      unlistenMenu?.();
      window.removeEventListener("keydown", onAltKey);
      window.removeEventListener("keyup", onAltKey);
    };
  }, []);

  return (
    <div className="flex h-full flex-col bg-window text-primary">
      <Toolbar />
      <FdaBanner />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <PaneArea />
        <GetInfoPanel />
      </div>
      <StatusBar />

      {/* overlays & transient chrome */}
      <PreviewOverlay />
      <CommandPalette />
      <FuzzyFinder />
      <SettingsOverlay />
      <ConflictDialog />
      <ConfirmDialog />
      <OpCards />
      <Toasts />
      <ContextMenuHost />
    </div>
  );
}
