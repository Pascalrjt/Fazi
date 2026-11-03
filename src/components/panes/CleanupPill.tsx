/**
 * The auto-cleanup notice: a red "⌛ 3 · tomorrow" pill in the focused pane's
 * footer, from any folder. Clicking it opens what's leaving, the rule, and
 * what you can do about it (Select / Keep, or Show in the folder from
 * elsewhere; Pause and Settings as icons).
 */
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { File, Folder, Hourglass, Pause, Settings2 } from "lucide-react";
import { useApp, toast, type PaneId } from "../../stores/app";
import { activeTabOf, usePanes } from "../../stores/panes";
import { useSettings } from "../../stores/settings";
import { leavingSoonAll, toggleKeep, useCleanup, type CleanupEntry } from "../../stores/cleanup";
import { leavingPhrase, ruleFolderName } from "../../lib/cleanup";
import { formatBytes, pluralize } from "../../lib/format";
import { focusActivePane } from "../../lib/keyboardFocus";

/** Rows listed before "and N more". */
const LIST_MAX = 5;

/** Total size, or null when a folder is involved (folders aren't walked). */
function totalBytes(items: CleanupEntry[]): number | null {
  if (items.some((i) => i.isDir || i.size == null)) return null;
  return items.reduce((sum, i) => sum + (i.size ?? 0), 0);
}

function Details({
  paneId,
  items,
  summary,
  onClose,
}: {
  paneId: PaneId;
  items: CleanupEntry[];
  /** "3 items leave tomorrow" */
  summary: string;
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Only the path drives rendering; handlers read the live tab.
  const tabPath = usePanes((s) => {
    const pane = s.panes.find((p) => p.id === paneId);
    return pane ? activeTabOf(pane).path : null;
  });
  const liveTab = () => {
    const pane = usePanes.getState().panes.find((p) => p.id === paneId);
    return pane ? activeTabOf(pane) : null;
  };

  const folders = [...new Map(items.map((i) => [i.folder, i.days])).entries()];
  const here = tabPath != null && folders.some(([f]) => f === tabPath);
  const bytes = totalBytes(items);
  const sorted = [...items].sort((a, b) => (a.expires ?? 0) - (b.expires ?? 0) || a.name.localeCompare(b.name));

  useEffect(() => {
    ref.current?.querySelector("button")?.focus();
  }, []);

  const selectThem = () => {
    const tab = liveTab();
    if (!tab) return;
    const paths = new Set(items.filter((i) => i.folder === tab.path).map((i) => i.path));
    const ids = tab.entries.filter((e) => paths.has(e.path)).map((e) => e.id);
    if (ids.length > 0) {
      usePanes.getState().setSelection(paneId, tab.id, { selected: new Set(ids), anchor: ids[0], lead: ids[0] });
    }
    onClose();
  };
  const show = () => {
    const tab = liveTab();
    if (tab) usePanes.getState().navigate(paneId, tab.id, folders[0][0]);
    onClose();
  };
  const keep = () => {
    toggleKeep(items.map((i) => i.path));
    onClose();
  };
  const pause = () => {
    useSettings.getState().patch({ cleanupEnabled: false });
    toast("Auto-cleanup is off", {
      action: { label: "Turn On", run: () => useSettings.getState().patch({ cleanupEnabled: true }) },
    });
    onClose();
  };
  const settings = () => {
    onClose();
    useApp.getState().openSettingsPane("cleanup");
  };

  const iconBtn =
    "focusable flex h-[26px] w-[26px] cursor-default items-center justify-center rounded-md text-tertiary hover:bg-hov hover:text-primary";
  const textBtn = "focusable h-[22px] cursor-default rounded-md px-2.5 text-[12px] font-medium";

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Auto-cleanup"
      className="anim-slide-up absolute bottom-[calc(100%+6px)] right-0 z-40 w-[300px] rounded-[11px] border border-edge bg-raised p-3 text-[12.5px] text-primary"
      style={{ boxShadow: "var(--shadow-overlay)" }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
        // Plain keys belong to the popover's buttons; ⌘ shortcuts still work.
        if (!e.metaKey) e.stopPropagation();
      }}
    >
      <div className="mb-2 flex items-baseline gap-2">
        <span className="flex-1 text-[13px] font-semibold">
          {summary}
        </span>
        {bytes != null && <span className="tnum text-[12px] text-tertiary">{formatBytes(bytes)}</span>}
      </div>
      <ul className="-mx-1 flex flex-col">
        {sorted.slice(0, LIST_MAX).map((i) => {
          const Icon = i.isDir ? Folder : File;
          return (
            <li key={i.path} className="flex h-[26px] items-center gap-2 px-1" title={i.path}>
              <Icon size={14} strokeWidth={1.75} className="shrink-0 text-tertiary" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{i.name}</span>
              {i.size != null && !i.isDir && (
                <span className="tnum text-[11.5px] text-tertiary">{formatBytes(i.size)}</span>
              )}
            </li>
          );
        })}
        {sorted.length > LIST_MAX && (
          <li className="flex h-[22px] items-center px-1 pl-[30px] text-[11.5px] text-tertiary">
            and {sorted.length - LIST_MAX} more
          </li>
        )}
      </ul>
      <div className="mb-3 mt-2.5 flex flex-col gap-1 border-t border-edge pt-2.5 text-[11.5px] text-tertiary">
        {folders.map(([folder, days]) => (
          <div key={folder} className="flex items-center gap-1.5">
            <Hourglass size={12} strokeWidth={1.75} className="shrink-0" aria-hidden />
            {folders.length > 1
              ? `${ruleFolderName(folder)}: cleared after ${pluralize(days, "day")}`
              : `Cleared after ${pluralize(days, "day")}`}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-1.5">
        {here ? (
          <button className={clsx(textBtn, "bg-accent text-white hover:brightness-110")} onClick={selectThem}>
            Select
          </button>
        ) : (
          <button className={clsx(textBtn, "bg-accent text-white hover:brightness-110")} onClick={show}>
            Show in {ruleFolderName(folders[0][0])}
          </button>
        )}
        <button
          className={clsx(textBtn, "text-secondary shadow-[inset_0_0_0_0.5px_var(--border-strong)] hover:bg-hov")}
          title="Never clean these up"
          onClick={keep}
        >
          Keep
        </button>
        <span className="flex-1" />
        <button className={iconBtn} title="Pause auto-cleanup" aria-label="Pause auto-cleanup" onClick={pause}>
          <Pause size={14} strokeWidth={1.75} />
        </button>
        <button className={iconBtn} title="Auto-cleanup settings" aria-label="Auto-cleanup settings" onClick={settings}>
          <Settings2 size={14} strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}

export function CleanupPill({ paneId }: { paneId: PaneId }) {
  // Subscribe to the inputs; derive the list outside the selector so a fresh
  // array doesn't re-render on every store write.
  const itemsMap = useCleanup((s) => s.items);
  const now = useCleanup((s) => s.now);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const items = leavingSoonAll({ ...useCleanup.getState(), items: itemsMap, now });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [open]);

  useEffect(() => {
    if (open && items.length === 0) setOpen(false);
  }, [open, items.length]);

  if (items.length === 0) return null;
  const summary = `${pluralize(items.length, "item")} ${items.length === 1 ? "leaves" : "leave"} ${leavingPhrase(items, now)}`;
  const close = () => {
    setOpen(false);
    focusActivePane();
  };
  return (
    <span ref={wrap} className="relative flex">
      <button
        className={clsx(
          "tnum flex h-[18px] cursor-default items-center gap-1 rounded-full pl-1.5 pr-2 font-semibold text-danger",
          open ? "bg-danger/20" : "bg-danger/10 hover:bg-danger/20",
        )}
        title={`Auto-cleanup: ${summary}`}
        aria-label={summary}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
      >
        <Hourglass size={11} strokeWidth={1.75} aria-hidden />
        {items.length}
        <span className="font-medium opacity-85">· {leavingPhrase(items, now)}</span>
      </button>
      {open && <Details paneId={paneId} items={items} summary={summary} onClose={close} />}
    </span>
  );
}
