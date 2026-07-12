/** Bottom-right non-modal op card stack: progress, rate, ETA, errors, retry. */
import clsx from "clsx";
import { useOps, opVerb, opFailVerb, type OpCard } from "../../stores/ops";
import { formatBytes, formatEta, formatRate, basename, pluralize } from "../../lib/format";

function progressFraction(card: OpCard): number | null {
  // Archive kinds get an explicit contract — never the bytes-vs-entries
  // heuristics below.
  if (card.kind === "compress") {
    if (card.totalBytes == null || card.totalBytes === 0) return null;
    // The backend byte ratchet can overshoot the uncompressed total before
    // Enumerated arrives (zip-size poll on incompressible data) and can never
    // come back down — the ≤100% clamp lives HERE at render time.
    return Math.min(1, card.bytesDone / card.totalBytes);
  }
  if (card.kind === "extract") {
    if (card.totalEntries == null || card.totalEntries === 0) return null;
    return Math.min(1, card.entriesDone / card.totalEntries);
  }
  if (card.cloned || card.totalBytes == null || card.totalBytes === 0) {
    if (card.totalEntries != null && card.totalEntries > 0) {
      return Math.min(1, card.entriesDone / card.totalEntries);
    }
    return null;
  }
  return Math.min(1, card.bytesDone / card.totalBytes);
}

function progressLine(card: OpCard): string {
  if (card.kind === "compress") {
    // Byte-only before totals; clamped bytes-of-total after.
    if (card.totalBytes != null && card.totalBytes > 0) {
      return `${formatBytes(Math.min(card.bytesDone, card.totalBytes))} of ${formatBytes(card.totalBytes)}`;
    }
    return `${formatBytes(card.bytesDone)} compressed…`;
  }
  if (card.kind === "extract") {
    // Entry-count mode only: N of M archives (absolute processed count).
    return card.totalEntries != null
      ? `${card.entriesDone.toLocaleString()} of ${pluralize(card.totalEntries, "archive")}`
      : `${card.entriesDone.toLocaleString()} archives`;
  }
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

/** "Compressing 3 items" → "Compressed 3 items" (derived, no verb regex). */
function doneLabel(card: OpCard): string {
  const running = opVerb(card.kind);
  if (card.label.startsWith(running)) {
    return opVerb(card.kind, true) + card.label.slice(running.length);
  }
  return card.label;
}

function CardView({ card }: { card: OpCard }) {
  const cancel = useOps((s) => s.cancel);
  const dismiss = useOps((s) => s.dismiss);
  const toggleExpanded = useOps((s) => s.toggleExpanded);
  const retry = useOps((s) => s.retry);

  const running = card.status === "running";
  const failed = card.status === "failed" || card.status === "partial";
  const fraction = progressFraction(card);
  // Rate/ETA are suppressed for archive kinds: compressed-bytes/sec against
  // an uncompressed total is meaningless, and extract counts archives.
  const isArchive = card.kind === "compress" || card.kind === "extract";
  const etaSeconds =
    running && !isArchive && fraction != null && card.rate > 0 && card.totalBytes != null
      ? (card.totalBytes - card.bytesDone) / card.rate
      : null;

  return (
    <div
      className="anim-slide-up w-[320px] rounded-lg border border-edge bg-raised p-3"
      style={{ boxShadow: "var(--shadow-overlay)" }}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-primary">
          {card.status === "success" ? doneLabel(card) : card.label}
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
            <span className="min-w-0 flex-1 truncate">
              {card.phase === "verifying" ? "Verifying…" : progressLine(card)}
            </span>
            {!card.cloned && !isArchive && card.rate > 1 && <span>{formatRate(card.rate)}</span>}
            {etaSeconds != null && <span>· {formatEta(etaSeconds)}</span>}
          </div>
          {card.currentPath && (
            <div className="mt-0.5 truncate text-[11px] text-tertiary">
              {basename(card.currentPath)}
            </div>
          )}
        </>
      )}

      {card.status === "success" && card.warnings.length === 0 && (
        <div className="mt-1 text-[11px] text-secondary">Done</div>
      )}

      {card.status === "cancelled" && (
        <div className="mt-1 text-[11px] text-secondary">Cancelled</div>
      )}

      {failed && (
        <div className="mt-1">
          <div className="text-[11px] text-danger">
            {card.errors.length > 0
              ? `${pluralize(card.errors.length, "item")} couldn't be ${opFailVerb(card.kind)}`
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

      {card.warnings.length > 0 && card.status !== "running" && (
        <div className="mt-2 rounded bg-pane p-2">
          {card.warnings.map((w, i) => (
            <div key={i} className="mb-1 text-[11px]">
              <div className="truncate text-secondary">
                {w.path ? basename(w.path) : "Operation"}
              </div>
              <div className={w.severity === "critical" ? "text-danger" : "text-accent"}>
                {w.message}
              </div>
            </div>
          ))}
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
