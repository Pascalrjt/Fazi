/** Bottom-center toast stack (≤3), with optional action button. Each one
 *  dismisses itself; hovering holds it so its button stays reachable. */
import { useLayoutEffect, useRef } from "react";
import clsx from "clsx";
import { X } from "lucide-react";
import { useApp, type Toast } from "../../stores/app";

const RADIUS = 9;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** The ✕ button, ringed by the time left before the toast closes itself. */
function DismissButton({ countdown, onClick }: { countdown: Toast["countdown"]; onClick: () => void }) {
  const ring = useRef<SVGCircleElement>(null);
  const { from, ms, held } = countdown;

  useLayoutEffect(() => {
    const el = ring.current;
    if (!el) return;
    const start = CIRCUMFERENCE * (1 - from);
    el.style.strokeDashoffset = String(held ? start : CIRCUMFERENCE);
    if (held || typeof el.animate !== "function") return;
    const run = el.animate([{ strokeDashoffset: start }, { strokeDashoffset: CIRCUMFERENCE }], {
      duration: ms,
      easing: "linear",
    });
    return () => run.cancel();
  }, [from, ms, held]);

  return (
    <button
      className="relative flex h-[22px] w-[22px] shrink-0 cursor-default items-center justify-center rounded-full text-tertiary hover:text-secondary"
      onClick={onClick}
      aria-label="Dismiss"
    >
      <svg className="absolute inset-0 -rotate-90" viewBox="0 0 22 22" aria-hidden>
        <circle cx="11" cy="11" r={RADIUS} fill="none" stroke="var(--border)" strokeWidth="1.5" />
        <circle
          ref={ring}
          cx="11"
          cy="11"
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
        />
      </svg>
      <X size={11} strokeWidth={2} />
    </button>
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  const hold = useApp((s) => s.holdToast);
  const release = useApp((s) => s.releaseToast);
  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-10 z-[80] flex flex-col items-center gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={clsx(
            "anim-slide-up pointer-events-auto flex max-w-[480px] items-center gap-3 rounded-lg border border-edge bg-raised py-2 pl-4 pr-2 text-[13px]",
            t.danger && "border-danger/40",
          )}
          style={{ boxShadow: "var(--shadow-overlay)" }}
          role={t.danger ? "alert" : "status"}
          onMouseEnter={() => hold(t.id)}
          onMouseLeave={() => release(t.id)}
        >
          <span className={clsx("min-w-0 truncate", t.danger ? "text-danger" : "text-primary")}>
            {t.message}
          </span>
          {t.action && (
            <button
              className="shrink-0 cursor-default rounded px-1.5 py-0.5 font-medium text-accent hover:bg-hov"
              onClick={() => {
                t.action?.run();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <DismissButton countdown={t.countdown} onClick={() => dismiss(t.id)} />
        </div>
      ))}
    </div>
  );
}
