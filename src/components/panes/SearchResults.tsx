/**
 * Global search results view (replaces the pane content while active).
 * Streamed mdfind rows: icon, name, path subtitle. Enter opens, ⌘R reveals
 * in enclosing folder, Esc returns to browse.
 */
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { useVirtualizer } from "@tanstack/react-virtual";
import { iconUrl } from "../../types/ipc";
import * as ipc from "../../lib/ipc";
import { useApp, toast, type SearchHit } from "../../stores/app";
import { useVolumes } from "../../stores/volumes";
import { revealInFazi } from "../../lib/actions";
import { displayPath } from "../../lib/format";

export function SearchResults() {
  const hits = useApp((s) => s.globalSearch.hits);
  const status = useApp((s) => s.globalSearch.status);
  const query = useApp((s) => s.globalSearch.query);
  const error = useApp((s) => s.globalSearch.error);
  const contents = useApp((s) => s.globalSearch.contents);
  const home = useVolumes((s) => s.folders?.home ?? null);
  const [selected, setSelected] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: hits.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 44,
    overscan: 10,
  });

  useEffect(() => {
    setSelected(0);
  }, [query]);

  useEffect(() => {
    if (selected >= 0 && selected < hits.length) {
      virtualizer.scrollToIndex(selected, { align: "auto" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const openHit = (hit: SearchHit | undefined) => {
    if (!hit) return;
    if (hit.isDir) {
      revealInFazi(hit.path);
      // for dirs, navigate into instead of selecting? Reveal-and-select is safer.
      return;
    }
    void ipc.openPaths([hit.path]).catch((err) => {
      toast(`Couldn't open: ${err}`, { danger: true });
    });
  };

  // capture-phase keys while results are shown and no input is focused
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      const app = useApp.getState();
      if (!app.globalSearch.active || app.paletteOpen || app.previewOpen) return;
      const cur = useApp.getState().globalSearch.hits;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopImmediatePropagation();
        setSelected((i) => Math.min(cur.length - 1, i + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopImmediatePropagation();
        setSelected((i) => Math.max(0, i - 1));
      } else if (e.key === "Enter" && !e.metaKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setSelected((i) => {
          openHit(cur[i]);
          return i;
        });
      } else if (e.code === "KeyR" && e.metaKey && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setSelected((i) => {
          const hit = cur[i];
          if (hit) revealInFazi(hit.path);
          return i;
        });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-edge px-3 text-xs text-secondary">
        <span>
          {status === "searching" && "Searching…"}
          {status === "done" &&
            (hits.length === 0 ? `No results for “${query}”` : `Results for “${query}”`)}
          {status === "error" && <span className="text-danger">Search failed: {error}</span>}
          {status === "idle" && "Type to search"}
        </span>
        {contents && <span className="text-tertiary">matching file contents</span>}
        <div className="flex-1" />
        <span className="text-tertiary">⏎ open · ⌘R reveal · esc back</span>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        {status === "done" && hits.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <div className="text-2xl text-tertiary">⌕</div>
            <div className="text-[13px] text-secondary">Nothing found for “{query}”</div>
            <div className="text-xs text-tertiary">
              Spotlight may not index this location — external and network volumes often aren't
              indexed.
            </div>
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
                    "flex cursor-default items-center gap-2.5 px-3",
                    isSel ? "bg-accent-dim" : "hover:bg-hov",
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
                    className="h-6 w-6 shrink-0"
                    draggable={false}
                    loading="lazy"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] text-primary">{hit.name}</div>
                    <div className="truncate text-[11px] text-tertiary">
                      {displayPath(hit.path, home)}
                    </div>
                  </div>
                  <button
                    className="shrink-0 cursor-default rounded px-1.5 py-0.5 text-[11px] text-tertiary hover:bg-hov hover:text-primary"
                    title="Reveal in enclosing folder (⌘R)"
                    onClick={(e) => {
                      e.stopPropagation();
                      revealInFazi(hit.path);
                    }}
                  >
                    ⌖
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
