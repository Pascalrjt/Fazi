/**
 * The content region: one pane card, or two side by side when split
 * (⌘⇧D), plus the Get Info card. The gutters are window frame, so they
 * double as a drag region.
 */
import { usePanes } from "../../stores/panes";
import { GetInfoPanel } from "../info/GetInfoPanel";
import { Pane } from "./Pane";

export function PaneArea() {
  const split = usePanes((s) => s.split);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 gap-2" data-tauri-drag-region>
      <Pane paneId="left" />
      {split && <Pane paneId="right" />}
      <GetInfoPanel />
    </div>
  );
}
