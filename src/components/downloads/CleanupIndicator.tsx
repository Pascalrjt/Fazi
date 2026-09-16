import { Clock3, ShieldCheck } from "lucide-react";
import { useDownloadsCleanup } from "../../stores/downloadsCleanup";
import {
  cleanupLabel,
  cleanupNear,
  cleanupTooltip,
} from "../../lib/downloadsCleanup";
export function CleanupIndicator({
  path,
  compact = false,
}: {
  path: string;
  compact?: boolean;
}) {
  const item = useDownloadsCleanup((s) => s.items[path]);
  const config = useDownloadsCleanup((s) => s.snapshot?.config);
  const now = useDownloadsCleanup((s) => s.now);
  if (!config?.enabled || !item) return null;
  const near = cleanupNear(item, config.retentionDays, now);
  const Icon = item.keep ? ShieldCheck : Clock3;
  return (
    <span
      title={cleanupTooltip(item)}
      className={`tnum inline-flex max-w-full items-center gap-1 truncate ${compact ? "rounded bg-window px-1 text-[10px]" : "text-[11px]"} ${near ? "text-warning" : "text-secondary"}`}
    >
      <Icon size={11} className="shrink-0" aria-hidden />
      {cleanupLabel(item, now)}
    </span>
  );
}
