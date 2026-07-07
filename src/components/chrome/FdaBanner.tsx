/** Full Disk Access onboarding card, shown once when FDA is missing. */
import { useEffect } from "react";
import * as ipc from "../../lib/ipc";
import { useApp } from "../../stores/app";
import { useSettings } from "../../stores/settings";

export function FdaBanner() {
  const fdaMissing = useApp((s) => s.fdaMissing);
  const setFdaMissing = useApp((s) => s.setFdaMissing);
  const dismissed = useSettings((s) => s.fdaBannerDismissed);
  const dismiss = useSettings((s) => s.dismissFdaBanner);

  useEffect(() => {
    ipc
      .checkFullDiskAccess()
      .then((ok) => setFdaMissing(!ok))
      .catch(() => setFdaMissing(false)); // no backend → don't nag
  }, [setFdaMissing]);

  if (!fdaMissing || dismissed) return null;

  return (
    <div className="anim-slide-up mx-3 mb-2 flex items-center gap-3 rounded-lg border border-edge bg-raised px-3 py-2">
      <span className="text-lg">🔒</span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-primary">Grant Full Disk Access</div>
        <div className="truncate text-xs text-secondary">
          Fazi needs Full Disk Access to browse protected folders like Desktop, Documents, and
          external drives.
        </div>
      </div>
      <button
        className="shrink-0 cursor-default rounded-md bg-accent px-3 py-1 text-xs font-medium text-white hover:opacity-90"
        onClick={() => void ipc.openFullDiskAccessSettings().catch(() => {})}
      >
        Open Settings
      </button>
      <button
        className="shrink-0 cursor-default px-1 text-tertiary hover:text-secondary"
        onClick={dismiss}
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}
