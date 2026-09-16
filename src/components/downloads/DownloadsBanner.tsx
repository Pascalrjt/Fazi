import { Clock3 } from "lucide-react";
import { useDownloadsCleanup } from "../../stores/downloadsCleanup";
import { useApp } from "../../stores/app";
import { cleanupNear } from "../../lib/downloadsCleanup";
export function DownloadsBanner({ path }: { path: string }) {
  const snapshot = useDownloadsCleanup((s) => s.snapshot);
  const now = useDownloadsCleanup((s) => s.now);
  const error = useDownloadsCleanup((s) => s.error);
  if (!snapshot?.config.enabled || path !== snapshot.root) return null;
  const count = snapshot.items.filter((i) =>
    cleanupNear(i, snapshot.config.retentionDays, now),
  ).length;
  return (
    <div className="flex min-h-8 shrink-0 items-center gap-2 border-b border-edge bg-window px-3 py-1 text-xs">
      <Clock3
        size={12}
        className={count ? "text-warning" : "text-secondary"}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate text-secondary">
        {error
          ? "Cleanup needs attention"
          : count
            ? `${count} file${count === 1 ? "" : "s"} nearing cleanup`
            : `Downloads move to Trash after ${snapshot.config.retentionDays} days`}
      </span>
      <button
        className="shrink-0 rounded border border-edge px-2 py-0.5 text-[11px] text-secondary hover:bg-hov"
        onClick={() => {
          useApp.setState({
            settingsPaneRequest: "downloads",
            settingsOpen: true,
          });
        }}
      >
        Review
      </button>
    </div>
  );
}
