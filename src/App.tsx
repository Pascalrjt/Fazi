/** Fazi application shell: rail layout, boot sequence, global overlays. */
import { useEffect, useRef } from "react";
import clsx from "clsx";
import { rebuildRegistry, registerAllCommands } from "./lib/commands";
import { getCommand } from "./lib/commands/registry";
import { runMenuCommand } from "./lib/commands/menuCommand";
import { useSettings } from "./stores/settings";
import { useKeyboard } from "./hooks/useKeyboard";
import * as ipc from "./lib/ipc";
import { setupFinderDragIn } from "./lib/ipc/dnd";
import { setAltDuringDrag } from "./lib/dnd";
import { recheckCutMirror } from "./lib/actions";
import { useVolumes } from "./stores/volumes";
import { activeTabOf, usePanes } from "./stores/panes";
import { focusActivePane } from "./lib/keyboardFocus";
import { useApp } from "./stores/app";
import { useVim } from "./stores/vim";
import { startCleanup } from "./stores/cleanup";
import { restoreOrBoot } from "./stores/session";
import { pluralize } from "./lib/format";
import { Toasts } from "./components/chrome/Toasts";
import { FdaBanner } from "./components/chrome/FdaBanner";
import { ConfirmDialog } from "./components/chrome/ConfirmDialog";
import { Sidebar } from "./components/sidebar/Sidebar";
import { TitleStrip } from "./components/chrome/TitleStrip";
import { PaneArea } from "./components/panes/PaneArea";
import { SettingsTab } from "./components/settings/SettingsTab";
import { OpCards } from "./components/ops/OpCards";
import { ConflictDialog } from "./components/ops/ConflictDialog";
import { CommandPalette } from "./components/palette/CommandPalette";
import { FuzzyFinder } from "./components/overlays/FuzzyFinder";
import { BatchRenameModal } from "./components/overlays/BatchRenameModal";
import { VimCheatSheet } from "./components/overlays/VimCheatSheet";
import { PreviewOverlay } from "./components/preview/PreviewOverlay";
import { ContextMenuHost } from "./components/menus/ContextMenu";

registerAllCommands(useSettings.getState().keybindingOverrides);

const NATIVE_MENU_COMMANDS = ["undo", "redo", "cut", "copy", "paste", "selectAll"] as const;

function syncNativeMenuShortcuts(): void {
  const shortcuts = Object.fromEntries(
    NATIVE_MENU_COMMANDS.map((id) => [id, getCommand(id)?.shortcut ?? null]),
  );
  try {
    void ipc.setNativeMenuShortcuts(shortcuts).catch(() => {});
  } catch {
    // Browser-only tests/dev preview have no Tauri bridge.
  }
}

// Keybinding overrides re-register the whole command set (labels, menus, and
// dispatch all read the registry). The Vim toggle re-registers too: sanitize
// strips Vim-reserved overrides only while the mode is on.
useSettings.subscribe((s, prev) => {
  if (s.keybindingOverrides !== prev.keybindingOverrides || s.vimMode !== prev.vimMode) {
    rebuildRegistry(s.keybindingOverrides);
    syncNativeMenuShortcuts();
  }
  if (s.vimMode !== prev.vimMode) useVim.getState().reset();
});

/** Each pane's current tab and folder, plus its tab count. */
function paneSignature(s: ReturnType<typeof usePanes.getState>): string {
  return s.panes.map((p) => `${p.activeTabId}\u0000${activeTabOf(p)?.path}\u0000${p.tabs.length}`).join("\n");
}

// Anything that switches or navigates a pane's tab (the palette, Go to
// File, Go menu commands, drag-moving tabs) brings the panes back from the
// Settings tab, the way following a link leaves a browser's settings page.
usePanes.subscribe((s, prev) => {
  if (!useApp.getState().settingsActive) return;
  if (paneSignature(s) !== paneSignature(prev)) useApp.getState().setSettingsActive(false);
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
    await restoreOrBoot(home);
    startCleanup();

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
  const sidebarPosition = useSettings((s) => s.sidebarPosition);
  const sidebarCollapsed = useSettings((s) => s.sidebarCollapsed);
  const settingsActive = useApp((s) => s.settingsActive);

  useEffect(() => {
    applyAppearance(theme, accent);
  }, [theme, accent]);

  // Leaving the Settings tab hands the keyboard back to the active pane.
  const wasSettings = useRef(false);
  useEffect(() => {
    if (wasSettings.current && !settingsActive) focusActivePane();
    wasSettings.current = settingsActive;
  }, [settingsActive]);

  useEffect(() => {
    boot();
    syncNativeMenuShortcuts();
    let alive = true;
    let unlistenDnd: (() => void) | undefined;
    let unlistenMenu: (() => void) | undefined;
    void setupFinderDragIn().then((fn) => {
      if (alive) unlistenDnd = fn;
      else fn();
    });
    ipc
      .onMenuCommand(runMenuCommand)
      .then((fn) => {
        if (alive) unlistenMenu = fn;
        else fn();
      })
      .catch(() => {});
    // Cut dimming goes stale when another app takes the pasteboard while
    // Fazi is in the background — re-validate on every focus regain.
    let unlistenFocus: (() => void) | undefined;
    ipc
      .onWindowFocused(() => void recheckCutMirror())
      .then((fn) => {
        if (alive) unlistenFocus = fn;
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
      unlistenFocus?.();
      window.removeEventListener("keydown", onAltKey);
      window.removeEventListener("keyup", onAltKey);
    };
  }, []);

  // Rail layout: a title strip across the window (traffic lights, path,
  // view controls), then the sidebar and the pane cards side by side on the
  // window frame. Each card carries its own status footer.
  return (
    <div className="flex h-full flex-col bg-window text-primary">
      <TitleStrip />
      <div
        className={clsx(
          "flex min-h-0 flex-1 gap-2 px-2 pb-2",
          sidebarPosition === "right" && "flex-row-reverse",
        )}
      >
        {!sidebarCollapsed && <Sidebar />}
        <main className="flex min-w-0 flex-1 flex-col gap-2" data-tauri-drag-region>
          <FdaBanner />
          {/* Panes stay mounted under the Settings tab so scroll and
              selection survive the round trip. */}
          <PaneArea hidden={settingsActive} />
          {settingsActive && <SettingsTab />}
        </main>
      </div>

      {/* overlays & transient chrome */}
      <PreviewOverlay />
      <CommandPalette />
      <FuzzyFinder />
      <BatchRenameModal />
      <VimCheatSheet />
      <ConflictDialog />
      <ConfirmDialog />
      <OpCards />
      <Toasts />
      <ContextMenuHost />
    </div>
  );
}
