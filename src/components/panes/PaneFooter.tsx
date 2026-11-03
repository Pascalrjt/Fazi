/**
 * A pane card's footer: "14 items, 3 selected — 2.4 GB" for that pane, plus
 * hidden-files and sorting notes. The focused pane also carries the
 * app-wide Vim mode indicator and auto-cleanup pill.
 */
import { useMemo } from "react";
import clsx from "clsx";
import { useShallow } from "zustand/react/shallow";
import { useApp, type PaneId } from "../../stores/app";
import { usePanes, activeTabOf } from "../../stores/panes";
import { paneSummary } from "../../lib/paneSummary";
import { useSettings } from "../../stores/settings";
import { useVim } from "../../stores/vim";
import { vimPendingLabel } from "../../lib/vim";
import { formatBytes, pluralize } from "../../lib/format";
import { CleanupPill } from "./CleanupPill";

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

export function PaneFooter({ paneId }: { paneId: PaneId }) {
  const activePaneId = useApp((s) => s.activePaneId);
  const searchActive = useApp((s) => s.globalSearch.active);
  const hitCount = useApp((s) => s.globalSearch.hits.length);
  const searchStatus = useApp((s) => s.globalSearch.status);
  const vimOn = useSettings((s) => s.vimMode);

  // Only the fields the footer shows: scroll, history and listing
  // bookkeeping changes don't re-render it.
  const tab = usePanes(
    useShallow((s) => {
      const pane = s.panes.find((p) => p.id === paneId);
      if (!pane) return null;
      const t = activeTabOf(pane);
      return {
        entries: t.entries,
        filter: t.filter,
        showHidden: t.showHidden,
        selection: t.selection,
        sorting: t.sorting,
      };
    }),
  );
  const isActive = activePaneId === paneId;
  const summary = useMemo(
    () => (tab ? paneSummary(tab) : null),
    [tab?.entries, tab?.filter, tab?.showHidden, tab?.selection], // eslint-disable-line react-hooks/exhaustive-deps
  );

  let text = "";
  let sizeText = "";
  if (searchActive && isActive) {
    text =
      searchStatus === "searching"
        ? `Searching… ${pluralize(hitCount, "result")}`
        : pluralize(hitCount, "result");
  } else if (summary) {
    text = pluralize(summary.visibleCount, "item");
    if (summary.selectedCount > 0) {
      text = `${summary.visibleCount} items, ${summary.selectedCount} selected`;
      if (summary.selectedBytes != null) sizeText = formatBytes(summary.selectedBytes);
    }
  }

  return (
    <div
      className={clsx(
        "flex h-[26px] shrink-0 items-center gap-3 border-t border-edge px-3 text-[11px]",
        isActive ? "text-secondary" : "text-tertiary",
      )}
    >
      {vimOn && isActive && <VimIndicator />}
      <span className="tnum">{text}</span>
      {sizeText && <span className="tnum text-tertiary">{sizeText}</span>}
      <div className="flex-1" />
      {tab?.showHidden && <span className="text-tertiary">Hidden files shown</span>}
      {tab?.sorting && <span className="text-tertiary">Sorting…</span>}
      {isActive && <CleanupPill paneId={paneId} />}
    </div>
  );
}
