/**
 * ⌘P fuzzy finder: custom input + virtualized results over the Rust index
 * (cmdk would re-filter client-side and defeat the nucleo ranker). Enter
 * opens, ⌘Enter reveals (navigate to parent + select), Tab toggles scope,
 * ⌘R rebuilds the index. The footer shows index freshness — the index is a
 * snapshot of the walk moment, not live.
 */
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { useVirtualizer } from "@tanstack/react-virtual";
import { iconUrl } from "../../types/ipc";
import type { FuzzyItem } from "../../types/ipc";
import * as ipc from "../../lib/ipc";
import { useFuzzy, type FuzzyScope } from "../../stores/fuzzy";
import { toast } from "../../stores/app";
import { usePanes, activePaneTab } from "../../stores/panes";
import { basename, displayPath } from "../../lib/format";
import { useVolumes } from "../../stores/volumes";

function relativeAge(ms: number): string {
  const delta = Math.max(0, Date.now() - ms);
  if (delta < 60_000) return "just now";
  const mins = Math.round(delta / 60_000);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function FuzzyFinder() {
  const open = useFuzzy((s) => s.open);
  const query = useFuzzy((s) => s.query);
  const hits = useFuzzy((s) => s.hits);
  const scope = useFuzzy((s) => s.scope);
  const indexed = useFuzzy((s) => s.indexed);
  const indexing = useFuzzy((s) => s.indexing);
  const capped = useFuzzy((s) => s.capped);
  const builtAtMs = useFuzzy((s) => s.builtAtMs);
  const error = useFuzzy((s) => s.error);
  const home = useVolumes((s) => s.folders?.home ?? null);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: hits.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 40,
    overscan: 8,
  });

  useEffect(() => {
    setSelected(0);
  }, [query, scope]);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    if (selected >= 0 && selected < hits.length) {
      virtualizer.scrollToIndex(selected, { align: "auto" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const openHit = (hit: FuzzyItem | undefined) => {
    if (!hit) return;
    useFuzzy.getState().close();
    if (hit.isDir) {
      const at = activePaneTab();
      if (at) usePanes.getState().navigate(at.pane.id, at.tab.id, hit.path);
      return;
    }
    void ipc.openPaths([hit.path]).catch((err) => toast(`Couldn't open: ${err}`, { danger: true }));
  };

  const revealHit = (hit: FuzzyItem | undefined) => {
    if (!hit) return;
    useFuzzy.getState().close();
    const at = activePaneTab();
    if (!at) return;
    const parent = hit.path.slice(0, hit.path.lastIndexOf("/")) || "/";
    usePanes
      .getState()
      .navigate(at.pane.id, at.tab.id, parent, { selectName: basename(hit.path) });
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const s = useFuzzy.getState();
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        s.close();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopImmediatePropagation();
        setSelected((i) => Math.min(s.hits.length - 1, i + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopImmediatePropagation();
        setSelected((i) => Math.max(0, i - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopImmediatePropagation();
        setSelected((i) => {
          if (e.metaKey) revealHit(s.hits[i]);
          else openHit(s.hits[i]);
          return i;
        });
      } else if (e.key === "Tab") {
        e.preventDefault();
        e.stopImmediatePropagation();
        s.setScope(s.scope === "folder" ? "home" : "folder");
      } else if (e.code === "KeyR" && e.metaKey && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        s.rebuild();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="anim-fade fixed inset-0 z-[85] flex items-start justify-center bg-black/30 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) useFuzzy.getState().close();
      }}
    >
      <div
        className="anim-pop flex max-h-[60vh] w-[560px] flex-col overflow-hidden rounded-xl border border-edge bg-raised"
        style={{ boxShadow: "var(--shadow-overlay)" }}
      >
        <div className="flex items-center gap-2 border-b border-edge px-4">
          <input
            ref={inputRef}
            value={query}
            placeholder="Jump to a file or folder…"
            onChange={(e) => useFuzzy.getState().setQuery(e.target.value)}
            className="min-w-0 flex-1 bg-transparent py-3 text-[14px] text-primary outline-none placeholder:text-tertiary"
            spellCheck={false}
          />
          <div className="flex shrink-0 items-center gap-0.5 rounded-md bg-pane p-0.5">
            {(
              [
                ["folder", "This Folder"],
                ["home", "Home"],
              ] as const
            ).map(([sc, label]) => (
              <button
                key={sc}
                className={clsx(
                  "cursor-default rounded px-1.5 py-0.5 text-[11px]",
                  scope === sc ? "bg-accent text-white" : "text-secondary hover:bg-hov",
                )}
                onClick={() => useFuzzy.getState().setScope(sc as FuzzyScope)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {error != null ? (
            <div className="px-3 py-6 text-center text-xs text-danger">{error}</div>
          ) : hits.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-tertiary">
              {query === ""
                ? indexing
                  ? "Indexing…"
                  : "Type to search the index"
                : indexing
                  ? "Searching (still indexing)…"
                  : "No matches"}
            </div>
          ) : (
            <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
              {virtualizer.getVirtualItems().map((vi) => {
                const hit = hits[vi.index];
                const isSel = vi.index === selected;
                return (
                  <div
                    key={vi.index}
                    className={clsx(
                      "flex cursor-default items-center gap-2.5 rounded-md px-2.5",
                      isSel ? "bg-accent text-white" : "hover:bg-hov",
                    )}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      right: 0,
                      height: vi.size,
                      transform: `translateY(${vi.start}px)`,
                    }}
                    onMouseDown={() => setSelected(vi.index)}
                    onDoubleClick={() => openHit(hit)}
                  >
                    <img
                      src={iconUrl(hit.icon, 32)}
                      alt=""
                      className="h-5 w-5 shrink-0"
                      draggable={false}
                      loading="lazy"
                    />
                    <div className="min-w-0 flex-1">
                      <div className={clsx("truncate text-[13px]", isSel ? "text-white" : "text-primary")}>
                        {hit.name}
                      </div>
                      <div className={clsx("truncate text-[11px]", isSel ? "text-white/70" : "text-tertiary")}>
                        {displayPath(hit.path, home)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex h-7 shrink-0 items-center gap-2 border-t border-edge px-3 text-[11px] text-tertiary">
          <span>
            {indexing
              ? `indexing… ${indexed.toLocaleString()} items`
              : `indexed ${indexed.toLocaleString()} items${builtAtMs ? ` · ${relativeAge(builtAtMs)}` : ""}`}
          </span>
          {capped && <span className="text-accent">index capped</span>}
          <div className="flex-1" />
          <button
            className="cursor-default rounded px-1.5 py-0.5 hover:bg-hov hover:text-secondary"
            title="Rebuild the index (⌘R)"
            onClick={() => useFuzzy.getState().rebuild()}
          >
            Rebuild
          </button>
          <span>⏎ open · ⌘⏎ reveal · ⇥ scope</span>
        </div>
      </div>
    </div>
  );
}
