/** The pane region: one pane, or two side-by-side when split (⌘⇧D). */
import { usePanes } from "../../stores/panes";
import { Pane } from "./Pane";

export function PaneArea() {
  const split = usePanes((s) => s.split);
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <Pane paneId="left" />
      {split && (
        <>
          <div className="w-px shrink-0 bg-edge" />
          <Pane paneId="right" />
        </>
      )}
    </div>
  );
}
