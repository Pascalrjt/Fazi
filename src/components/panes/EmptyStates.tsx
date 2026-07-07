/** Designed pane states: empty folder, permission denied, error, loading. */
import type { ListErrorCode } from "../../types/ipc";
import * as ipc from "../../lib/ipc";
import { newFolderInActive, pasteIntoActive } from "../../lib/actions";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      {children}
    </div>
  );
}

function GhostButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      className="cursor-default rounded-md border border-edge bg-raised px-3 py-1.5 text-xs text-primary hover:bg-hov"
      onClick={onClick}
    >
      {label}
    </button>
  );
}

export function EmptyFolder() {
  return (
    <Shell>
      <div className="text-3xl text-tertiary">◌</div>
      <div className="text-[13px] text-secondary">This folder is empty</div>
      <div className="flex gap-2">
        <GhostButton label="New Folder" onClick={newFolderInActive} />
        <GhostButton label="Paste" onClick={() => pasteIntoActive(false)} />
      </div>
    </Shell>
  );
}

export function NoFilterMatches({ filter }: { filter: string }) {
  return (
    <Shell>
      <div className="text-3xl text-tertiary">⌕</div>
      <div className="text-[13px] text-secondary">
        Nothing here matches “{filter}”
      </div>
    </Shell>
  );
}

export function ListingError({
  code,
  message,
}: {
  code: ListErrorCode | "unknown";
  message: string;
}) {
  if (code === "permissionDenied") {
    return (
      <Shell>
        <div className="text-3xl text-tertiary">🔒</div>
        <div className="text-[13px] font-medium text-primary">You don't have permission to see this folder</div>
        <div className="max-w-[360px] text-xs text-secondary">
          Grant Fazi Full Disk Access in System Settings to browse protected locations.
        </div>
        <GhostButton
          label="Grant access…"
          onClick={() => void ipc.openFullDiskAccessSettings().catch(() => {})}
        />
      </Shell>
    );
  }
  if (code === "notFound" || code === "notADirectory") {
    return (
      <Shell>
        <div className="text-3xl text-tertiary">?</div>
        <div className="text-[13px] font-medium text-primary">This folder doesn't exist anymore</div>
        <div className="max-w-[360px] break-all text-xs text-secondary">{message}</div>
      </Shell>
    );
  }
  return (
    <Shell>
      <div className="text-3xl text-danger">⚠</div>
      <div className="text-[13px] font-medium text-primary">Couldn't open this folder</div>
      <div className="max-w-[360px] break-all text-xs text-secondary">{message}</div>
    </Shell>
  );
}
