/** Above the list in a rule folder, only while something leaves by tomorrow. */
import { Hourglass } from "lucide-react";
import { useCleanup, leavingSoonIn } from "../../stores/cleanup";
import { usePanes } from "../../stores/panes";
import { useApp, toast, type PaneId } from "../../stores/app";
import { useSettings } from "../../stores/settings";
import { countWithSize, leavingPhrase } from "../../lib/cleanup";
import { pluralize } from "../../lib/format";

export function CleanupBanner({
  paneId,
  tabId,
  folder,
}: {
  paneId: PaneId;
  tabId: string;
  folder: string;
}) {
  // Subscribe to the inputs; derive the list outside the selector so a
  // fresh array doesn't re-render on every store write.
  const items = useCleanup((s) => s.items);
  const now = useCleanup((s) => s.now);
  const dismissedFor = useCleanup((s) => s.dismissed[folder]);
  const days = useCleanup((s) => s.reports.find((r) => r.folder === folder)?.days);

  const leaving = leavingSoonIn(folder, { ...useCleanup.getState(), items, now });
  if (leaving.length === 0 || days == null) return null;
  const signature = leaving
    .map((i) => i.path)
    .sort()
    .join("\n");
  if (dismissedFor === signature) return null;

  const selectThem = () => {
    const tab = usePanes
      .getState()
      .panes.find((p) => p.id === paneId)
      ?.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const paths = new Set(leaving.map((i) => i.path));
    const ids = tab.entries.filter((e) => paths.has(e.path)).map((e) => e.id);
    if (ids.length === 0) return;
    usePanes.getState().setSelection(paneId, tabId, {
      selected: new Set(ids),
      anchor: ids[0],
      lead: ids[0],
    });
    useApp.getState().setActivePane(paneId);
  };

  const pause = () => {
    useSettings.getState().patch({ cleanupEnabled: false });
    toast("Auto-cleanup is off", {
      action: {
        label: "Turn On",
        run: () => useSettings.getState().patch({ cleanupEnabled: true }),
      },
    });
  };

  return (
    <div className="mx-2 mt-2 flex shrink-0 items-center gap-3 rounded-lg border border-edge bg-raised px-3 py-1.5 text-xs">
      <Hourglass size={14} strokeWidth={1.75} className="shrink-0 text-secondary" aria-hidden />
      <div className="min-w-0 flex-1 truncate text-secondary">
        <span className="font-medium text-primary">Auto-cleanup is on.</span> Items move to the
        Trash {pluralize(days, "day")} after they arrive.{" "}
        <span className="tnum text-danger">
          {countWithSize(leaving)} {leaving.length === 1 ? "goes" : "go"}{" "}
          {leavingPhrase(leaving, now)}.
        </span>
      </div>
      <button
        className="shrink-0 cursor-default rounded border border-edge-strong px-2 py-0.5 text-[11px] text-secondary hover:bg-hov"
        onClick={selectThem}
      >
        Select Them
      </button>
      <button
        className="shrink-0 cursor-default rounded border border-edge-strong px-2 py-0.5 text-[11px] text-secondary hover:bg-hov"
        onClick={pause}
      >
        Pause
      </button>
      <button
        className="shrink-0 cursor-default px-1 text-tertiary hover:text-secondary"
        onClick={() => useCleanup.getState().dismissBanner(folder, signature)}
        aria-label="Dismiss"
        title="Hide until the list changes"
      >
        ✕
      </button>
    </div>
  );
}
