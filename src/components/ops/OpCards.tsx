/** Bottom-right non-modal op card stack: progress, rate, ETA, errors, retry. */
import clsx from "clsx";
import { useOps, type OpCard } from "../../stores/ops";
import { formatBytes, formatEta, formatRate, basename, pluralize } from "../../lib/format";

function progressFraction(card: OpCard): number | null {
  if (card.cloned || card.totalBytes == null || card.totalBytes === 0) {
    if (card.totalEntries != null && card.totalEntries > 0) {
      return Math.min(1, card.entriesDone / card.totalEntries);
    }
    return null;
  }
  return Math.min(1, card.bytesDone / card.totalBytes);
}

function progressLine(card: OpCard): string {
  if (card.cloned || (card.totalBytes == null && card.totalEntries != null)) {
    // entry-count mode (clone fast path)
    return card.totalEntries != null
      ? `${card.entriesDone.toLocaleString()} of ${card.totalEntries.toLocaleString()} items`
      : `${card.entriesDone.toLocaleString()} items`;
  }
  if (card.totalBytes != null) {
    return `${formatBytes(card.bytesDone)} of ${formatBytes(card.totalBytes)}`;
  }
  return `${formatBytes(card.bytesDone)} copied…`;
}

function CardView({ card }: { card: OpCard }) {
  const cancel = useOps((s) => s.cancel);
  const dismiss = useOps((s) => s.dismiss);
  const toggleExpanded = useOps((s) => s.toggleExpanded);
  const retry = useOps((s) => s.retry);
  const downloadAndRetry = useOps((s) => s.downloadAndRetrySkipped);

  const running = card.status === "running";
  const failed = card.status === "failed" || card.status === "partial";
  const fraction = progressFraction(card);
  const etaSeconds =
    running && fraction != null && card.rate > 0 && card.totalBytes != null
      ? (card.totalBytes - card.bytesDone) / card.rate
      : null;

  return (
    <div
      className="anim-slide-up w-[320px] rounded-lg border border-edge bg-raised p-3"
      style={{ boxShadow: "var(--shadow-overlay)" }}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-primary">
          {card.status === "success"
            ? card.label.replace(/^(Copying|Moving|Duplicating)/, (v) =>
                v === "Copying" ? "Copied" : v === "Moving" ? "Moved" : "Duplicated",
              )
            : card.label}
        </span>
        {running ? (
          <button
            className="shrink-0 cursor-default rounded px-1 text-tertiary hover:text-primary"
            title="Cancel"
            onClick={() => cancel(card.opId)}
          >
            ✕
          </button>
        ) : (
          <button
            className="shrink-0 cursor-default rounded px-1 text-tertiary hover:text-primary"
            title="Dismiss"
            onClick={() => dismiss(card.opId)}
          >
            ✕
          </button>
        )}
      </div>

      {running && (
        <>
          <div className={clsx("op-progress mt-2", fraction == null && "indeterminate")}>
            <div style={{ width: `${(fraction ?? 0.3) * 100}%` }} />
          </div>
          <div className="tnum mt-1.5 flex items-center gap-2 text-[11px] text-secondary">
            <span className="min-w-0 flex-1 truncate">{progressLine(card)}</span>
            {!card.cloned && card.rate > 1 && <span>{formatRate(card.rate)}</span>}
            {etaSeconds != null && <span>· {formatEta(etaSeconds)}</span>}
          </div>
          {card.currentPath && (
            <div className="mt-0.5 truncate text-[11px] text-tertiary">
              {basename(card.currentPath)}
            </div>
          )}
        </>
      )}

      {card.status === "success" && card.skippedIcloud.length === 0 && (
        <div className="mt-1 text-[11px] text-secondary">Done</div>
      )}

      {card.status === "cancelled" && (
        <div className="mt-1 text-[11px] text-secondary">Cancelled</div>
      )}

      {failed && (
        <div className="mt-1">
          <div className="text-[11px] text-danger">
            {card.errors.length > 0
              ? `${pluralize(card.errors.length, "item")} couldn't be ${
                  card.kind === "move" ? "moved" : "copied"
                }`
              : "The operation failed"}
          </div>
          <div className="mt-1.5 flex gap-2">
            {card.errors.length > 0 && (
              <button
                className="cursor-default rounded border border-edge px-2 py-0.5 text-[11px] text-secondary hover:bg-hov"
                onClick={() => toggleExpanded(card.opId)}
              >
                {card.expanded ? "Hide details" : "Details"}
              </button>
            )}
            <button
              className="cursor-default rounded border border-edge px-2 py-0.5 text-[11px] text-secondary hover:bg-hov"
              onClick={() => retry(card.opId)}
            >
              Retry
            </button>
          </div>
          {card.expanded && (
            <div className="mt-2 max-h-32 overflow-y-auto rounded bg-pane p-2">
              {card.errors.map((err, i) => (
                <div key={i} className="mb-1 text-[11px]">
                  <div className="truncate text-secondary">{err.path ? basename(err.path) : "Operation"}</div>
                  <div className="truncate text-danger">{err.message}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {card.skippedIcloud.length > 0 && card.status !== "running" && (
        <div className="mt-2 rounded bg-pane p-2">
          <div className="text-[11px] text-secondary">
            {pluralize(card.skippedIcloud.length, "item")} skipped (not downloaded from iCloud)
          </div>
          <button
            className="mt-1.5 cursor-default rounded bg-accent px-2 py-0.5 text-[11px] font-medium text-white hover:opacity-90"
            onClick={() => downloadAndRetry(card.opId)}
          >
            Download & retry skipped
          </button>
        </div>
      )}
    </div>
  );
}

export function OpCards() {
  const cards = useOps((s) => s.cards);
  const visibleCards = cards.filter((c) => c.visible);
  if (visibleCards.length === 0) return null;
  return (
    <div className="fixed bottom-9 right-3 z-[70] flex flex-col gap-2">
      {visibleCards.map((card) => (
        <CardView key={card.opId} card={card} />
      ))}
    </div>
  );
}
