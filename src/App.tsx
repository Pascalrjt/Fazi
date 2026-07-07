/** Fazi application shell: layout grid, boot sequence, global overlays. */
import { useEffect } from "react";
import { registerAllCommands } from "./lib/commands";
import { runCommand } from "./lib/commands/registry";
import { useKeyboard } from "./hooks/useKeyboard";
import * as ipc from "./lib/ipc";
import { setupFinderDragIn } from "./lib/ipc/dnd";
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
import { OpCards } from "./components/ops/OpCards";
import { ConflictDialog } from "./components/ops/ConflictDialog";
import { CommandPalette } from "./components/palette/CommandPalette";
import { PreviewOverlay } from "./components/preview/PreviewOverlay";
import { ContextMenuHost } from "./components/menus/ContextMenu";

registerAllCommands();

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
    return () => {
      alive = false;
      unlistenDnd?.();
      unlistenMenu?.();
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
      <ConflictDialog />
      <ConfirmDialog />
      <OpCards />
      <Toasts />
      <ContextMenuHost />
    </div>
  );
}
