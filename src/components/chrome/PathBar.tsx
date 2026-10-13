/**
 * Breadcrumb path bar for one pane: clickable crumbs, native drop targets,
 * and an editable mode (double-click, or ⌘⇧G for the active pane). The
 * "address" variant lives inside the title strip's address field: inside
 * the home folder it starts at "~", and editing happens in place.
 */
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { useApp, type PaneId } from "../../stores/app";
import { usePanes, activeTabOf } from "../../stores/panes";
import { useVolumes } from "../../stores/volumes";
import { pathSegments } from "../../lib/format";
import { activeDragPaths, isInvalidDrop, onDropHover, registerDropZone } from "../../lib/dnd";
import { captureBrowseFocus, restoreBrowseFocus } from "../../lib/keyboardFocus";

export function PathBar({
  paneId,
  maxSegments = 4,
  variant = "plain",
}: {
  paneId: PaneId;
  maxSegments?: number;
  variant?: "plain" | "address";
}) {
  const home = useVolumes((s) => s.folders?.home ?? null);
  const activePaneId = useApp((s) => s.activePaneId);
  // Path editing is app-wide state; only the active pane's bar edits.
  const editing = useApp((s) => s.pathBarEditing) && activePaneId === paneId;
  const setEditing = useApp((s) => s.setPathBarEditing);
  const setActivePane = useApp((s) => s.setActivePane);
  const pane = usePanes((s) => s.panes.find((p) => p.id === paneId));
  const navigate = usePanes((s) => s.navigate);
  const tab = pane ? activeTabOf(pane) : null;
  const [draft, setDraft] = useState("");
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const crumbsRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const startEditing = () => {
    if (activePaneId !== paneId) setActivePane(paneId);
    setEditing(true);
  };

  const finishEditing = (restore: boolean) => {
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    setEditing(false);
    if (restore) requestAnimationFrame(() => restoreBrowseFocus(target));
  };

  useEffect(() => {
    if (editing && tab) {
      returnFocusRef.current ??= captureBrowseFocus();
      setDraft(tab.path);
      // focus after mount
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  // Native drop target: each crumb accepts a drop into its directory. Crumb
  // rects are queried live from the DOM so navigation never leaves a stale
  // closure behind (same trick as the sidebar's insertIndexFromPoint).
  useEffect(() => {
    return registerDropZone({
      priority: 30,
      hitTest: (x, y) => {
        const crumbs = crumbsRef.current?.querySelectorAll<HTMLElement>("[data-crumb-path]");
        for (const el of crumbs ?? []) {
          const r = el.getBoundingClientRect();
          if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
          const dest = el.dataset.crumbPath;
          if (!dest) continue;
          const paths = activeDragPaths();
          if (paths != null && isInvalidDrop(paths, dest)) return null;
          return { action: "copyTo", destDir: dest, targetKey: `crumb:${paneId}:${dest}` };
        }
        return null;
      },
    });
  }, [paneId]);

  useEffect(() => {
    const prefix = `crumb:${paneId}:`;
    return onDropHover((h) =>
      setDropTarget(
        h != null && h.hit.action === "copyTo" && h.hit.targetKey?.startsWith(prefix)
          ? h.hit.destDir
          : null,
      ),
    );
  }, [paneId]);

  if (!tab || !pane) return null;

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const path = draft.trim().replace(/^~(?=\/|$)/, useVolumes.getState().folders?.home ?? "~");
            if (path.startsWith("/")) {
              navigate(pane.id, tab.id, path.length > 1 ? path.replace(/\/+$/, "") : "/");
            }
            finishEditing(true);
          } else if (e.key === "Escape") {
            finishEditing(true);
          }
        }}
        onBlur={() => finishEditing(false)}
        className={clsx(
          "h-7 min-w-0 flex-1 font-mono text-xs text-primary outline-none",
          variant === "address"
            ? "bg-transparent px-1"
            : "rounded-md border border-accent bg-pane px-2",
        )}
        spellCheck={false}
        placeholder="/path/to/folder"
      />
    );
  }

  let segs = pathSegments(tab.path);
  if (variant === "address" && home != null && home !== "/") {
    // Inside the home folder, start at "~" like a typed path would.
    const at = segs.findIndex((seg) => seg.path === home);
    if (at !== -1) segs = [{ name: "~", path: home }, ...segs.slice(at + 1)];
  }
  const shown = segs.length > maxSegments ? segs.slice(-maxSegments) : segs;
  const elided = segs.length > maxSegments;

  return (
    <div
      ref={crumbsRef}
      className="flex h-7 min-w-0 flex-1 items-center gap-0.5 overflow-hidden rounded-md"
      onDoubleClick={startEditing}
      onMouseDownCapture={() => {
        returnFocusRef.current = captureBrowseFocus();
      }}
      data-tauri-drag-region
    >
      {elided && <span className="shrink-0 px-1 text-xs text-tertiary">…</span>}
      {shown.map((seg, i) => {
        const current = i === shown.length - 1;
        return (
          <span key={seg.path} className={clsx("flex min-w-0 items-center", current && "shrink-0")}>
            {(i > 0 || elided) && <span className="px-0.5 text-[10px] text-tertiary">›</span>}
            <button
              className={clsx(
                "focusable min-w-0 cursor-default truncate rounded px-1.5 py-0.5",
                current
                  ? "text-[14px] font-semibold text-primary"
                  : "text-[13px] text-secondary hover:bg-hov hover:text-primary",
                dropTarget === seg.path && "drop-ring",
              )}
              onClick={() => {
                if (seg.path !== tab.path) navigate(pane.id, tab.id, seg.path);
              }}
              data-crumb-path={seg.path}
            >
              {seg.name}
            </button>
          </span>
        );
      })}
      <div className="h-full min-w-4 flex-1" onClick={startEditing} data-tauri-drag-region />
    </div>
  );
}
