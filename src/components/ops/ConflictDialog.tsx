/**
 * Finder-familiar conflict modal: icon pair, both sides' size+date,
 * Keep Both / Replace / Skip (Merge highlighted default for dir-dir),
 * apply-to-all, Replace marked not undoable.
 */
import { useState } from "react";
import clsx from "clsx";
import { useOps, type PendingConflict } from "../../stores/ops";
import type { ConflictResponse, ConflictSide } from "../../types/ipc";
import { iconUrl } from "../../types/ipc";
import { basename, formatBytes, formatDateFull } from "../../lib/format";

function SideCard({ side, title }: { side: ConflictSide; title: string }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center gap-1 rounded-lg bg-pane p-3">
      <img src={iconUrl(side.icon, 64)} alt="" className="h-10 w-10" draggable={false} />
      <div className="text-[11px] font-medium uppercase tracking-wide text-tertiary">{title}</div>
      <div className="tnum text-xs text-secondary">
        {side.isDir ? "Folder" : formatBytes(side.size)}
      </div>
      <div className="tnum text-[11px] text-tertiary">{formatDateFull(side.mtime)}</div>
    </div>
  );
}

function DialogBody({ conflict }: { conflict: PendingConflict }) {
  const respond = useOps((s) => s.respondConflict);
  const [applyToAll, setApplyToAll] = useState(false);
  const name = basename(conflict.dest.path);
  const isDirDir = conflict.kind === "dirDir";
  const isMixed = conflict.kind === "fileDir" || conflict.kind === "dirFile";

  const answer = (response: ConflictResponse) => {
    respond(response, applyToAll && !isMixed);
  };

  return (
    <div
      className="anim-pop w-[440px] rounded-xl border border-edge bg-raised p-5"
      style={{ boxShadow: "var(--shadow-overlay)" }}
      role="dialog"
      aria-modal="true"
      onKeyDown={(e) => {
        if (e.key === "Escape") answer("cancel");
        if (e.key === "Enter") answer(isDirDir ? "merge" : "keepBoth");
      }}
    >
      <div className="text-[14px] font-semibold text-primary">
        An item named “{name}” already exists in this folder
      </div>
      <div className="mt-1 text-xs text-secondary">
        {isMixed
          ? conflict.kind === "fileDir"
            ? "You're replacing a folder with a file. This can't be undone and won't be applied to other items."
            : "You're replacing a file with a folder. This can't be undone and won't be applied to other items."
          : isDirDir
            ? "Do you want to merge the folders, replace the existing one, or skip it?"
            : "Do you want to keep both, replace the existing item, or skip it?"}
      </div>

      <div className="mt-4 flex gap-3">
        <SideCard side={conflict.source} title="Moving in" />
        <SideCard side={conflict.dest} title="Already here" />
      </div>

      {!isMixed && conflict.remaining > 0 && (
        <label className="mt-4 flex cursor-default items-center gap-2 text-xs text-secondary">
          <input
            type="checkbox"
            checked={applyToAll}
            onChange={(e) => setApplyToAll(e.target.checked)}
          />
          Apply to all {conflict.remaining} remaining {conflict.remaining === 1 ? "item" : "items"}
        </label>
      )}

      <div className="mt-5 flex items-center justify-end gap-2">
        <button
          className="cursor-default rounded-md border border-edge px-3 py-1.5 text-xs text-secondary hover:bg-hov"
          onClick={() => answer("skip")}
        >
          Skip
        </button>
        <div className="flex flex-col items-center">
          <button
            className="cursor-default rounded-md border border-edge px-3 py-1.5 text-xs text-primary hover:bg-hov"
            onClick={() => answer("replace")}
          >
            Replace
          </button>
          <span className="mt-0.5 text-[10px] text-danger">not undoable</span>
        </div>
        {isDirDir ? (
          <button
            autoFocus
            className={clsx(
              "cursor-default rounded-md bg-accent px-4 py-1.5 text-xs font-medium text-white hover:opacity-90",
            )}
            onClick={() => answer("merge")}
          >
            Merge
          </button>
        ) : (
          <button
            autoFocus
            disabled={isMixed}
            className={clsx(
              "cursor-default rounded-md px-4 py-1.5 text-xs font-medium",
              isMixed
                ? "border border-edge text-tertiary"
                : "bg-accent text-white hover:opacity-90",
            )}
            onClick={() => answer("keepBoth")}
          >
            Keep Both
          </button>
        )}
      </div>
    </div>
  );
}

export function ConflictDialog() {
  const conflict = useOps((s) => s.conflicts[0]);
  if (!conflict) return null;
  return (
    <div className="anim-fade fixed inset-0 z-[90] flex items-center justify-center bg-black/40">
      <DialogBody key={`${conflict.opId}:${conflict.conflictId}`} conflict={conflict} />
    </div>
  );
}
