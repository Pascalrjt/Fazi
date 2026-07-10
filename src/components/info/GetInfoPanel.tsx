/**
 * Get Info slide-over (⌘I): icon, kind, sizes (lazy dir_size with live count),
 * dates, where-from, permissions, tag editor. Aggregates multi-selections.
 */
import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import type { Entry, GetInfoResult } from "../../types/ipc";
import { iconUrl } from "../../types/ipc";
import * as ipc from "../../lib/ipc";
import { safeIpc } from "../../lib/safeIpc";
import { useApp } from "../../stores/app";
import { usePanes, activeTabOf, visibleEntries } from "../../stores/panes";
import { entryKindLabel } from "../../lib/sort";
import { formatBytes, formatDateFull, pluralize } from "../../lib/format";
import { FINDER_TAG_COLORS } from "../../lib/tags";
import { setEntryTags } from "../../lib/actions";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 py-1 text-xs">
      <span className="w-[88px] shrink-0 text-right text-tertiary">{label}</span>
      <span className="tnum min-w-0 flex-1 select-text break-words text-secondary">{children}</span>
    </div>
  );
}

function TagEditor({ entry }: { entry: Entry }) {
  const [colors, setColors] = useState<Set<number>>(
    () => new Set(entry.tags.map((t) => t.color)),
  );

  useEffect(() => {
    setColors(new Set(entry.tags.map((t) => t.color)));
  }, [entry]);

  const toggle = (color: number) => {
    const next = new Set(colors);
    if (next.has(color)) next.delete(color);
    else next.add(color);
    setColors(next);
    setEntryTags(entry, [...next]);
  };

  return (
    <div className="mt-1 flex items-center gap-2">
      {Object.entries(FINDER_TAG_COLORS).map(([colorStr, spec]) => {
        const color = Number(colorStr);
        const active = colors.has(color);
        return (
          <button
            key={color}
            title={spec.name}
            className={clsx(
              "h-4 w-4 cursor-default rounded-full transition-transform",
              active && "scale-110 ring-2 ring-accent ring-offset-1 ring-offset-raised",
            )}
            style={{ background: spec.css }}
            onClick={() => toggle(color)}
          />
        );
      })}
    </div>
  );
}

function DirSize({ path }: { path: string }) {
  const [progress, setProgress] = useState<{ bytes: number; entries: number; done: boolean }>({
    bytes: 0,
    entries: 0,
    done: false,
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setProgress({ bytes: 0, entries: 0, done: false });
    setError(null);
    safeIpc(() =>
      ipc.dirSize(path, (e) => {
        if (alive) setProgress({ bytes: e.bytes, entries: e.entries, done: e.done });
      }),
    )
      .catch((err) => {
        if (alive) setError(String(err));
      });
    return () => {
      alive = false;
    };
  }, [path]);

  if (error) return <>—</>;
  return (
    <>
      {formatBytes(progress.bytes)} · {pluralize(progress.entries, "item")}
      {!progress.done && <span className="text-tertiary"> — calculating…</span>}
    </>
  );
}

function SingleInfo({ entry }: { entry: Entry }) {
  const [info, setInfo] = useState<GetInfoResult | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setInfo(null);
    setInfoError(null);
    ipc
      .getInfo(entry.path)
      .then((res) => {
        if (alive) setInfo(res);
      })
      .catch((err) => {
        if (alive) setInfoError(String(err));
      });
    return () => {
      alive = false;
    };
  }, [entry.path]);

  const isDir = entry.kind === "dir" && !entry.isPackage;

  return (
    <>
      <div className="flex items-center gap-3 px-4 pb-3">
        <img src={iconUrl(entry.icon, 128)} alt="" className="h-12 w-12" draggable={false} />
        <div className="min-w-0">
          <div className="select-text break-words text-[14px] font-semibold text-primary">
            {entry.name}
          </div>
          <div className="text-xs text-secondary">{entryKindLabel(entry)}</div>
        </div>
      </div>
      <div className="mx-4 border-t border-edge py-2">
        <Row label="Size">
          {isDir ? <DirSize path={entry.path} /> : formatBytes(entry.size)}
        </Row>
        <Row label="Where">
          <span className="select-text break-all">{entry.path}</span>
        </Row>
        <Row label="Created">{formatDateFull(entry.btime)}</Row>
        <Row label="Modified">{formatDateFull(entry.mtime)}</Row>
        {entry.kind === "symlink" && entry.linkTarget && (
          <Row label="Links to">
            <span className="select-text break-all">{entry.linkTarget}</span>
          </Row>
        )}
      </div>
      <div className="mx-4 border-t border-edge py-2">
        {infoError ? (
          <Row label="Details">unavailable</Row>
        ) : info ? (
          <>
            <Row label="Permissions">{info.permissionsOctal}</Row>
            <Row label="Owner">
              {info.owner}
              {info.group ? ` (${info.group})` : ""}
            </Row>
            {info.whereFrom && info.whereFrom.length > 0 && (
              <Row label="Where from">
                <span className="select-text break-all">{info.whereFrom.join("\n")}</span>
              </Row>
            )}
            {info.sizeOnDisk != null && <Row label="On disk">{formatBytes(info.sizeOnDisk)}</Row>}
          </>
        ) : (
          <Row label="Details">loading…</Row>
        )}
      </div>
      <div className="mx-4 border-t border-edge py-2">
        <div className="flex gap-2 py-1 text-xs">
          <span className="w-[88px] shrink-0 text-right text-tertiary">Tags</span>
          <TagEditor entry={entry} />
        </div>
      </div>
    </>
  );
}

function MultiInfo({ entries }: { entries: Entry[] }) {
  const totalKnown = entries.reduce<number>((acc, e) => acc + (e.size ?? 0), 0);
  const dirCount = entries.filter((e) => e.kind === "dir" && !e.isPackage).length;
  return (
    <>
      <div className="flex items-center gap-3 px-4 pb-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-pane text-lg text-secondary">
          {entries.length}
        </div>
        <div>
          <div className="text-[14px] font-semibold text-primary">
            {pluralize(entries.length, "item")}
          </div>
          <div className="text-xs text-secondary">
            {dirCount > 0 ? `${pluralize(dirCount, "folder")}, ` : ""}
            {pluralize(entries.length - dirCount, "file")}
          </div>
        </div>
      </div>
      <div className="mx-4 border-t border-edge py-2">
        <Row label="Total size">
          {formatBytes(totalKnown)}
          {dirCount > 0 && <span className="text-tertiary"> (folders not counted)</span>}
        </Row>
      </div>
    </>
  );
}

export function GetInfoPanel() {
  const open = useApp((s) => s.getInfoOpen);
  const setOpen = useApp((s) => s.setGetInfoOpen);
  const activePaneId = useApp((s) => s.activePaneId);
  const pane = usePanes((s) => s.panes.find((p) => p.id === activePaneId) ?? s.panes[0]);
  const tab = pane ? activeTabOf(pane) : null;

  const selected = useMemo(() => {
    if (!tab) return [];
    return visibleEntries(tab).filter((e) => tab.selection.selected.has(e.id));
  }, [tab]);

  if (!open || !tab) return null;

  return (
    <div className="anim-slide-left flex w-[280px] shrink-0 flex-col overflow-y-auto border-l border-edge bg-raised py-3">
      <div className="flex items-center justify-between px-4 pb-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-tertiary">
          Info
        </span>
        <button
          className="cursor-default rounded px-1 text-tertiary hover:text-primary"
          onClick={() => setOpen(false)}
          aria-label="Close info"
        >
          ✕
        </button>
      </div>
      {selected.length === 0 ? (
        <div className="px-4 py-4 text-xs text-tertiary">Select an item to see its info.</div>
      ) : selected.length === 1 ? (
        <SingleInfo entry={selected[0]} />
      ) : (
        <MultiInfo entries={selected} />
      )}
    </div>
  );
}
