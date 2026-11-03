/**
 * The numbers behind a pane footer ("14 items, 3 selected — 2.4 GB"),
 * computed from the cached visible view and the selection set instead of
 * refiltering the whole listing per pane update.
 */
import type { Entry } from "../types/ipc";
import type { SelectionState } from "./selection";
import { visibleView } from "./visibleView";

export interface PaneSummaryInput {
  entries: Entry[];
  filter: string;
  showHidden: boolean;
  selection: SelectionState;
}

export interface PaneSummary {
  visibleCount: number;
  selectedCount: number;
  /** Sum of known sizes of selected rows; null when none is known. */
  selectedBytes: number | null;
}

export function paneSummary(tab: PaneSummaryInput): PaneSummary {
  const visibleCount = visibleView(tab).entries.length;
  const selected = tab.selection.selected;
  let selectedBytes: number | null = null;
  if (selected.size > 0) {
    // id → index over ALL entries (the unfiltered view, cached per listing)
    const all = visibleView({ entries: tab.entries, filter: "", showHidden: true });
    const index = all.indexById;
    for (const id of selected) {
      const i = index.get(id);
      if (i == null) continue;
      const size = tab.entries[i].size;
      if (size != null) selectedBytes = (selectedBytes ?? 0) + size;
    }
  }
  return { visibleCount, selectedCount: selected.size, selectedBytes };
}

/** Entries of `tab` whose ids are selected, restricted to visible rows, in display order. */
export function visibleSelection(tab: PaneSummaryInput): Entry[] {
  const view = visibleView(tab);
  const selected = tab.selection.selected;
  if (selected.size === 0) return [];
  const out: Entry[] = [];
  if (selected.size * 16 < view.entries.length) {
    // few selected: look each up, then restore display order
    const hits: number[] = [];
    for (const id of selected) {
      const i = view.indexOf(id);
      if (i >= 0) hits.push(i);
    }
    hits.sort((a, b) => a - b);
    for (const i of hits) out.push(view.entries[i]);
    return out;
  }
  for (const e of view.entries) if (selected.has(e.id)) out.push(e);
  return out;
}
