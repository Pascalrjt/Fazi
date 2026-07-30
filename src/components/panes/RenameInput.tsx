/**
 * Inline filename editor, shared by the list and grid views.
 *
 * Layout is the only view-specific coupling (see `wrapperClassName`): the list
 * wants the field to grow along the row, the grid wants it centered under the
 * thumbnail. Everything else — validation, the commit path, the double-commit
 * guard, the stem preselect — is layout-agnostic.
 */
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import clsx from "clsx";
import type { Entry } from "../../types/ipc";
import * as ipc from "../../lib/ipc";
import { usePanes } from "../../stores/panes";
import { toast, type PaneId } from "../../stores/app";
import { splitExt } from "../../lib/format";
import { renameValidationError } from "../../lib/actions";

/** Matches the list row's flex layout; the grid overrides it. */
const LIST_RENAME_WRAPPER = "relative flex min-w-0 flex-1 items-center";

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
      {error && value !== entry.name && (
        <span className="absolute left-0 top-full z-40 mt-1 whitespace-nowrap rounded border border-edge bg-raised px-2 py-0.5 text-[11px] text-danger shadow-lg">
          {error}
        </span>
      )}
    </span>
  );
}
