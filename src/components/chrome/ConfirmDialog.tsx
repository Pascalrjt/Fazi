/** Generic confirm modal — used only for destructive actions (permanent delete). */
import { useApp } from "../../stores/app";

export function ConfirmDialog() {
  const confirm = useApp((s) => s.confirm);
  const close = useApp((s) => s.closeConfirm);
  if (!confirm) return null;

  const run = () => {
    close();
    confirm.onConfirm();
  };

  return (
    <div className="anim-fade fixed inset-0 z-[90] flex items-center justify-center bg-black/40">
      <div
        className="anim-pop w-[380px] rounded-xl border border-edge bg-raised p-5"
        role="alertdialog"
        aria-modal="true"
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
          if (e.key === "Enter") run();
        }}
      >
        <div className="text-[14px] font-semibold text-primary">{confirm.title}</div>
        <div className="mt-2 text-xs text-secondary">{confirm.message}</div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            autoFocus
            className="cursor-default rounded-md border border-edge px-3 py-1.5 text-xs text-secondary hover:bg-hov"
            onClick={close}
          >
            Cancel
          </button>
          <button
            className={
              confirm.danger
                ? "cursor-default rounded-md bg-danger px-4 py-1.5 text-xs font-medium text-white hover:opacity-90"
                : "cursor-default rounded-md bg-accent px-4 py-1.5 text-xs font-medium text-white hover:opacity-90"
            }
            onClick={run}
          >
            {confirm.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
