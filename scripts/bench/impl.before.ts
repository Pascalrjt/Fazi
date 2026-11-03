/**
 * Adapter: the baseline (dfe2197) computations, copied verbatim from the old
 * components/lib so the same workload runs against them. Only used when the
 * harness runs in the baseline worktree (BENCH_IMPL=before).
 */
import type { Entry } from "../../src/types/ipc";
import type { Tab } from "../../src/stores/panes";
import { visibleEntries } from "../../src/stores/panes";
import { marqueeSelect, type ItemRect, type Rect } from "../../src/lib/selection";

export const name = "before";

/** Old PaneFooter body (ran unmemoized on every pane update). */
export function footer(tab: Tab): unknown {
  const visible = visibleEntries(tab);
  const selectedIds = tab.selection.selected;
  let bytes: number | null = null;
  if (selectedIds.size > 0) {
    bytes = tab.entries
      .filter((e) => selectedIds.has(e.id))
      .reduce<number | null>((acc, e) => (e.size == null ? acc : (acc ?? 0) + e.size), null);
  }
  return { visibleCount: visible.length, selectedCount: selectedIds.size, bytes };
}

/** Old PreviewOverlay + GetInfoPanel memos (ran before their `if (!open)`). */
export function overlaysClosed(tab: Tab): unknown {
  const vis = visibleEntries(tab);
  const sel = vis.filter((e) => tab.selection.selected.has(e.id));
  const list = sel.length > 1 ? sel : vis;
  const info = visibleEntries(tab).filter((e) => tab.selection.selected.has(e.id));
  return [list, info];
}

/** Old takeBatch loop: queue.shift() per id. */
export function drainQueue(ids: number[]): number {
  const queue = ids.slice();
  let n = 0;
  while (queue.length > 0) {
    for (let i = 0; i < 128 && queue.length > 0; i++) {
      queue.shift();
      n++;
    }
  }
  return n;
}

export function marqueeSetup(visible: Entry[], rowH: number, width: number): ItemRect[] {
  return visible.map((en, i) => ({
    id: en.id,
    rect: { x: 0, y: i * rowH, width, height: rowH },
  }));
}
export function marqueeMove(state: unknown, rect: Rect): unknown {
  return marqueeSelect(rect, state as ItemRect[], null);
}

/** Old FileList/GridView `visible` memo body. */
export function visibleMemo(tab: Tab): unknown {
  return visibleEntries({ entries: tab.entries, filter: tab.filter, showHidden: tab.showHidden });
}
