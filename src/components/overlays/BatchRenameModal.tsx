/**
 * Batch rename modal (⌘⇧R): regex find/replace, prefix/suffix, numbering —
 * live preview table with collision flags; Apply stays disabled until every
 * row is clean. The backend applies the whole batch atomically (two-phase,
 * one undo entry).
 */
import { useMemo, useState } from "react";
import clsx from "clsx";
import * as ipc from "../../lib/ipc";
import {
  applyBatchRename,
  batchCollisions,
  compileFind,
  nameRuleError,
  type BatchRenameSpec,
} from "../../lib/batchRename";
import { useApp, toast } from "../../stores/app";
import { activePaneTab, selectedEntries, usePanes } from "../../stores/panes";
import { pluralize } from "../../lib/format";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex items-center gap-2 text-[12px] text-secondary">
      <span className="w-16 shrink-0 text-right">{label}</span>
      {children}
    </label>
  );
}

const inputCls =
  "min-w-0 flex-1 rounded-md border border-edge bg-pane px-2 py-1 text-[12px] text-primary outline-none focus:border-accent";

export function BatchRenameModal() {
  const open = useApp((s) => s.batchRenameOpen);
  const setOpen = useApp((s) => s.setBatchRenameOpen);
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [caseInsensitive, setCaseInsensitive] = useState(false);
  const [prefix, setPrefix] = useState("");
  const [suffix, setSuffix] = useState("");
  const [numbering, setNumbering] = useState(false);
  const [numStart, setNumStart] = useState(1);
  const [numStep, setNumStep] = useState(1);
  const [numDigits, setNumDigits] = useState(2);
  const [numPos, setNumPos] = useState<"prefix" | "suffix">("suffix");
  const [applying, setApplying] = useState(false);

  const entries = useMemo(() => (open ? selectedEntries() : []), [open]);

  const spec: BatchRenameSpec = {
    find: find || undefined,
    replace: find ? replace : undefined,
    caseInsensitive,
    prefix: prefix || undefined,
    suffix: suffix || undefined,
    numbering: numbering
      ? { start: numStart, step: numStep, digits: numDigits, position: numPos }
      : undefined,
  };

  const fromNames = entries.map((e) => e.name);
  const toNames = useMemo(
    () => applyBatchRename(fromNames, spec),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, find, replace, caseInsensitive, prefix, suffix, numbering, numStart, numStep, numDigits, numPos],
  );
  const siblings = activePaneTab()?.tab.entries.map((e) => e.name) ?? [];
  const collisions = batchCollisions(fromNames, toNames, siblings);
  const invalidRegex = find !== "" && compileFind(spec) === null;
  const invalidName = toNames.some((n) => nameRuleError(n) !== null);
  const changed = toNames.some((n, i) => n !== fromNames[i]);
  const blocked =
    !changed || invalidRegex || invalidName || collisions.some(Boolean) || applying;

  const close = () => {
    setOpen(false);
    setApplying(false);
  };

  const apply = () => {
    if (blocked) return;
    setApplying(true);
    const renames = entries
      .map((e, i) => ({ from: e.path, toName: toNames[i] }))
      .filter((_, i) => toNames[i] !== fromNames[i]);
    ipc
      .batchRename(renames)
      .then(() => {
        toast(`Renamed ${pluralize(renames.length, "item")}`);
        const at = activePaneTab();
        if (at) usePanes.getState().refresh(at.pane.id, at.tab.id);
        close();
      })
      .catch((err) => {
        setApplying(false);
        toast(`Batch rename failed: ${err}`, { danger: true });
      });
  };

  if (!open) return null;

  return (
    <div
      className="anim-fade fixed inset-0 z-[85] flex items-start justify-center bg-black/30 pt-[10vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          close();
        }
      }}
    >
      <div
        className="anim-pop flex max-h-[72vh] w-[640px] flex-col overflow-hidden rounded-xl border border-edge bg-raised"
        style={{ boxShadow: "var(--shadow-overlay)" }}
      >
        <div className="border-b border-edge px-4 py-3 text-[14px] font-medium text-primary">
          Rename {pluralize(entries.length, "item")}
        </div>

        <div className="grid grid-cols-2 gap-x-6 gap-y-2 border-b border-edge px-4 py-3">
          <Field label="Find">
            <input
              className={clsx(inputCls, invalidRegex && "border-danger")}
              value={find}
              onChange={(e) => setFind(e.target.value)}
              placeholder="regex, e.g. IMG_(\d+)"
              spellCheck={false}
              autoFocus
            />
          </Field>
          <Field label="Replace">
            <input
              className={inputCls}
              value={replace}
              onChange={(e) => setReplace(e.target.value)}
              placeholder="$1 supported"
              spellCheck={false}
            />
          </Field>
          <Field label="Prefix">
            <input className={inputCls} value={prefix} onChange={(e) => setPrefix(e.target.value)} spellCheck={false} />
          </Field>
          <Field label="Suffix">
            <input className={inputCls} value={suffix} onChange={(e) => setSuffix(e.target.value)} spellCheck={false} />
          </Field>
          <Field label="Options">
            <label className="flex items-center gap-1.5 text-[12px] text-secondary">
              <input
                type="checkbox"
                checked={caseInsensitive}
                onChange={(e) => setCaseInsensitive(e.target.checked)}
              />
              ignore case
            </label>
          </Field>
          <Field label="Number">
            <div className="flex items-center gap-1.5">
              <input type="checkbox" checked={numbering} onChange={(e) => setNumbering(e.target.checked)} />
              <input
                type="number"
                className="w-14 rounded-md border border-edge bg-pane px-1.5 py-0.5 text-[12px] text-primary outline-none"
                title="Start"
                value={numStart}
                disabled={!numbering}
                onChange={(e) => setNumStart(Number(e.target.value) || 0)}
              />
              <input
                type="number"
                className="w-12 rounded-md border border-edge bg-pane px-1.5 py-0.5 text-[12px] text-primary outline-none"
                title="Step"
                value={numStep}
                disabled={!numbering}
                onChange={(e) => setNumStep(Number(e.target.value) || 1)}
              />
              <input
                type="number"
                className="w-12 rounded-md border border-edge bg-pane px-1.5 py-0.5 text-[12px] text-primary outline-none"
                title="Digits"
                value={numDigits}
                disabled={!numbering}
                onChange={(e) => setNumDigits(Math.max(1, Number(e.target.value) || 1))}
              />
              <select
                className="rounded-md border border-edge bg-pane px-1 py-0.5 text-[12px] text-primary outline-none"
                value={numPos}
                disabled={!numbering}
                onChange={(e) => setNumPos(e.target.value as "prefix" | "suffix")}
              >
                <option value="suffix">after name</option>
                <option value="prefix">before name</option>
              </select>
            </div>
          </Field>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
          {entries.map((e, i) => {
            const dirty = toNames[i] !== e.name;
            const bad = collisions[i] || toNames[i] === "";
            return (
              <div key={e.id} className="flex items-center gap-2 py-0.5 text-[12px]">
                <span className="min-w-0 flex-1 truncate text-secondary">{e.name}</span>
                <span className="shrink-0 text-tertiary">→</span>
                <span
                  data-testid={`preview-${i}`}
                  className={clsx(
                    "min-w-0 flex-1 truncate",
                    bad ? "text-danger" : dirty ? "text-primary" : "text-tertiary",
                  )}
                >
                  {toNames[i]}
                  {bad && " (collision)"}
                </span>
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-2 border-t border-edge px-4 py-3">
          {invalidRegex && <span className="text-[11px] text-danger">Invalid regex</span>}
          <div className="flex-1" />
          <button
            className="cursor-default rounded-md border border-edge px-3 py-1 text-[12px] text-secondary hover:bg-hov"
            onClick={close}
          >
            Cancel
          </button>
          <button
            className="cursor-default rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-white disabled:opacity-40"
            disabled={blocked}
            onClick={apply}
          >
            Rename
          </button>
        </div>
      </div>
    </div>
  );
}
