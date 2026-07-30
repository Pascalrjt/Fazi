/** "14 items, 3 selected — 2.4 GB" + hidden-files and Vim-mode indicators. */
import { useMemo } from "react";
import clsx from "clsx";
import { useShallow } from "zustand/react/shallow";
import { useApp } from "../../stores/app";
import { usePanes, activeTabIn, visibleEntries } from "../../stores/panes";
import { useSettings } from "../../stores/settings";
import { useVim } from "../../stores/vim";
import { vimPendingLabel } from "../../lib/vim";
import { formatBytes, pluralize } from "../../lib/format";

/** NORMAL / VISUAL plus the in-flight count/prefix ("12", "g"); FILTER while
 *  a text field owns the keyboard — the explicit state the feedback loop
 *  needs to make pending sequences understandable. */
function VimIndicator() {
  const vim = useVim((s) => s.state);
  const filterOwns = useApp((s) => s.searchFieldFocused || s.pathBarEditing);
  const renaming = useApp((s) => s.renaming != null);
  const pending = vimPendingLabel(vim);
  const label = filterOwns ? "FILTER" : renaming ? "RENAME" : vim.mode.toUpperCase();
  return (
    <button
      className={clsx(
        "tnum cursor-default font-medium tracking-wide hover:text-secondary",
        vim.mode === "visual" && !filterOwns && !renaming ? "text-accent" : "text-tertiary",
      )}
      title="Vim commands (g?)"
      onClick={() => {
        const app = useApp.getState();
        app.setVimHelpOpen(!app.vimHelpOpen);
      }}
    >
      {label}
      {!filterOwns && !renaming && pending !== "" && <span className="ml-1.5">{pending}</span>}
    </button>
  );
}

export function StatusBar() {
  const activePaneId = useApp((s) => s.activePaneId);
  const searchActive = useApp((s) => s.globalSearch.active);
  const hitCount = useApp((s) => s.globalSearch.hits.length);
  const searchStatus = useApp((s) => s.globalSearch.status);
  const vimOn = useSettings((s) => s.vimMode);

  // Narrowed inputs: entry-array identity, filter/hidden, and selection —
  // scroll and unrelated tab changes no longer reach this component.
  const { hasTab, entries, filter, showHidden, selection, sorting } = usePanes(
    useShallow((s) => {
      const tab = activeTabIn(s, activePaneId);
      return {
        hasTab: tab != null,
        entries: tab?.entries ?? null,
        filter: tab?.filter ?? "",
        showHidden: tab?.showHidden ?? false,
        selection: tab?.selection ?? null,
        sorting: tab?.sorting ?? false,
      };
    }),
  );

  const visibleCount = useMemo(
    () => (entries ? visibleEntries({ entries, filter, showHidden }).length : 0),
    [entries, filter, showHidden],
  );
  const selectedIds = selection?.selected ?? null;
  const selectedBytes = useMemo(() => {
    if (!entries || !selectedIds || selectedIds.size === 0) return null;
    return entries
      .filter((e) => selectedIds.has(e.id))
      .reduce<number | null>(
        (acc, e) => (e.size == null ? acc : (acc ?? 0) + e.size),
        null,
      );
  }, [entries, selectedIds]);

  let text = "";
  let sizeText = "";
  if (searchActive) {
    text =
      searchStatus === "searching"
        ? `Searching… ${pluralize(hitCount, "result")}`
        : pluralize(hitCount, "result");
  } else if (hasTab) {
    text = pluralize(visibleCount, "item");
    if (selectedIds != null && selectedIds.size > 0) {
      text = `${visibleCount} items, ${selectedIds.size} selected`;
      if (selectedBytes != null) sizeText = formatBytes(selectedBytes);
    }
  }

  return (
    <div className="flex h-6 shrink-0 items-center gap-3 border-t border-edge bg-window px-3 text-[11px] text-secondary">
      {vimOn && <VimIndicator />}
      <span className="tnum">{text}</span>
      {sizeText && <span className="tnum">— {sizeText}</span>}
      <div className="flex-1" />
      {showHidden && <span className="text-tertiary">hidden files shown</span>}
      {sorting && <span className="text-tertiary">sorting…</span>}
    </div>
  );
}
