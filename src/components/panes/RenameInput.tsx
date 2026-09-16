/**
 * Inline filename editor, shared by the list and grid views.
 *
 * Layout is the only view-specific coupling (see `wrapperClassName`): the list
 * wants the field to grow along the row, the grid wants it centered under the
 * thumbnail. Everything else — validation, the commit path, the double-commit
 * guard, the stem preselect — is layout-agnostic.
 */
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import type { Entry } from "../../types/ipc";
import * as ipc from "../../lib/ipc";
import { usePanes } from "../../stores/panes";
import { toast, type PaneId } from "../../stores/app";
import { splitExt } from "../../lib/format";
import { renameValidationError } from "../../lib/actions";

/** Matches the list row's flex layout; the grid overrides it. */
export const LIST_RENAME_WRAPPER = "relative flex min-w-0 flex-1 items-center";

export function RenameInput({
  entry,
  paneId,
  tabId,
  wrapperClassName = LIST_RENAME_WRAPPER,
  onDone,
}: {
  entry: Entry;
  paneId: PaneId;
  tabId: string;
  wrapperClassName?: string;
  onDone: (committed: boolean, advance: boolean) => void;
}) {
  const [value, setValue] = useState(entry.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);
  const siblings = usePanes(
    useCallback(
      (s) =>
        s.panes.find((p) => p.id === paneId)?.tabs.find((t) => t.id === tabId)?.entries ?? [],
      [paneId, tabId],
    ),
  );
  const error = renameValidationError(value.trim(), siblings, entry.name);
  const showError = error != null && value !== entry.name;

  // The bubble is portaled to <body> and fixed-positioned from the input's
  // rect: virtualized rows are transformed (each a stacking context), so an
  // in-row absolute bubble gets painted over by later rows and clipped by the
  // pane's overflow. Near the viewport bottom it flips above the input.
  const [errorPos, setErrorPos] = useState<{
    left: number;
    top: number;
    above: boolean;
  } | null>(null);

  useLayoutEffect(() => {
    if (!showError) {
      setErrorPos(null);
      return;
    }
    const update = () => {
      const rect = inputRef.current?.getBoundingClientRect();
      if (!rect) return;
      const above = rect.bottom + 32 > window.innerHeight;
      setErrorPos({
        left: rect.left,
        top: above ? rect.top - 4 : rect.bottom + 4,
        above,
      });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [showError]);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    // preselect name sans extension (dirs: whole name)
    const [stem] = entry.kind === "dir" && !entry.isPackage ? [entry.name] : splitExt(entry.name);
    input.setSelectionRange(0, stem.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commit = (advance: boolean) => {
    if (committedRef.current) return;
    const newName = value.trim();
    if (newName === entry.name || newName === "") {
      committedRef.current = true;
      onDone(false, advance);
      return;
    }
    if (error) return; // invalid — stay in rename mode
    committedRef.current = true;
    const entryId = entry.id;
    ipc
      .renamePath(entry.path, newName)
      .then((newPath) => {
        usePanes.getState().renameLocal(paneId, tabId, entryId, newName, newPath);
      })
      .catch((err) => {
        toast(`Couldn't rename “${entry.name}”: ${err}`, { danger: true });
      });
    onDone(true, advance);
  };

  return (
    <span className={wrapperClassName} title={error ?? undefined}>
      <input
        ref={inputRef}
        className={clsx("rename-input w-full", error && value !== entry.name && "invalid")}
        value={value}
        spellCheck={false}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            commit(false);
          } else if (e.key === "Tab") {
            e.preventDefault();
            commit(true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            committedRef.current = true;
            onDone(false, false);
          }
        }}
        onBlur={() => commit(false)}
      />
      {showError &&
        errorPos &&
        createPortal(
          <span
            className="pointer-events-none fixed z-[90] whitespace-nowrap rounded border border-edge bg-raised px-2 py-0.5 text-[11px] text-danger shadow-lg"
            style={{
              left: errorPos.left,
              top: errorPos.top,
              transform: errorPos.above ? "translateY(-100%)" : undefined,
            }}
          >
            {error}
          </span>,
          document.body,
        )}
    </span>
  );
}
