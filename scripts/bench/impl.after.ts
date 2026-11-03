/** Adapter: the current tree's implementations of moved/derived computations. */
import type { Entry } from "../../src/types/ipc";
import type { Tab } from "../../src/stores/panes";
import { paneSummary } from "../../src/lib/paneSummary";
import { IdQueue } from "../../src/lib/hydration";
import { marqueeSelectRows, type Rect } from "../../src/lib/selection";
import { tabView } from "../../src/stores/panes";

export const name = "after";

/** PaneFooter's numbers for one pane update (memoized component calls this). */
export function footer(tab: Tab): unknown {
  return paneSummary(tab);
}

/** PreviewOverlay + GetInfoPanel work per pane update while both are closed:
 *  they no longer subscribe or compute until opened. */
export function overlaysClosed(_tab: Tab): unknown {
  return null;
}

/** Hydration background queue: take every batch of 128 ids. */
export function drainQueue(ids: number[]): number {
  const q = new IdQueue(ids.slice());
  let n = 0;
  while (q.size > 0) {
    for (let i = 0; i < 128 && q.size > 0; i++) {
      q.shift();
      n++;
    }
  }
  return n;
}

/** List-view marquee: per-mousedown setup + per-mousemove selection. */
export function marqueeSetup(visible: Entry[], _rowH: number, _width: number): unknown {
  return visible; // hits come from arithmetic; no per-row rects
}
export function marqueeMove(
  state: unknown,
  rect: Rect,
  rowH: number,
  width: number,
  tab: Tab,
): unknown {
  void state;
  return marqueeSelectRows(rect, tabView(tab).ids, rowH, width, null);
}

/** FileList/GridView `visible` memo after a listing commit. */
export function visibleMemo(tab: Tab): unknown {
  return tabView(tab).entries;
}
