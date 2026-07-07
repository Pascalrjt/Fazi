/** "14 items, 3 selected — 2.4 GB" + hidden-files indicator. */
import { useApp } from "../../stores/app";
import { usePanes, activeTabOf, visibleEntries } from "../../stores/panes";
import { formatBytes, pluralize } from "../../lib/format";

export function StatusBar() {
  const activePaneId = useApp((s) => s.activePaneId);
  const searchActive = useApp((s) => s.globalSearch.active);
  const hitCount = useApp((s) => s.globalSearch.hits.length);
  const searchStatus = useApp((s) => s.globalSearch.status);

  const pane = usePanes((s) => s.panes.find((p) => p.id === activePaneId) ?? s.panes[0]);
  const tab = pane ? activeTabOf(pane) : null;

  let text = "";
  let sizeText = "";
  if (searchActive) {
    text =
      searchStatus === "searching"
        ? `Searching… ${pluralize(hitCount, "result")}`
        : pluralize(hitCount, "result");
  } else if (tab) {
    const visible = visibleEntries(tab);
    const selectedIds = tab.selection.selected;
    text = pluralize(visible.length, "item");
    if (selectedIds.size > 0) {
      text = `${visible.length} items, ${selectedIds.size} selected`;
      const bytes = tab.entries
        .filter((e) => selectedIds.has(e.id))
        .reduce<number | null>(
          (acc, e) => (e.size == null ? acc : (acc ?? 0) + e.size),
          null,
        );
      if (bytes != null) sizeText = formatBytes(bytes);
    }
  }

  return (
    <div className="flex h-6 shrink-0 items-center gap-3 border-t border-edge bg-window px-3 text-[11px] text-secondary">
      <span className="tnum">{text}</span>
      {sizeText && <span className="tnum">— {sizeText}</span>}
      <div className="flex-1" />
      {tab?.showHidden && <span className="text-tertiary">hidden files shown</span>}
      {tab?.sorting && <span className="text-tertiary">sorting…</span>}
    </div>
  );
}
