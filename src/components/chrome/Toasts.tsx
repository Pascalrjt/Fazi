/** Bottom-center toast stack (≤3), with optional action button. */
import clsx from "clsx";
import { useApp } from "../../stores/app";

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-10 z-[80] flex flex-col items-center gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={clsx(
            "anim-slide-up pointer-events-auto flex max-w-[480px] items-center gap-3 rounded-lg border border-edge bg-raised px-4 py-2 text-[13px]",
            t.danger && "border-danger/40",
          )}
          style={{ boxShadow: "var(--shadow-overlay)" }}
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
          <button
            className="shrink-0 cursor-default text-tertiary hover:text-secondary"
            onClick={() => dismiss(t.id)}
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
