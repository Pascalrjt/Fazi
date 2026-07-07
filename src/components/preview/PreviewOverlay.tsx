/**
 * Space-bar preview overlay: images (zoom/pan), AV (native controls via
 * preview:// with Range), text/code (readTextHead in a <pre> with line
 * numbers), everything else a large thumbnail with an info caption.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Entry } from "../../types/ipc";
import { previewUrl, thumbUrl } from "../../types/ipc";
import * as ipc from "../../lib/ipc";
import { useApp } from "../../stores/app";
import { usePanes, activeTabOf, visibleEntries } from "../../stores/panes";
import { previewModeFor } from "../../lib/fileTypes";
import { entryKindLabel } from "../../lib/sort";
import { formatBytes, formatDateFull } from "../../lib/format";

const TEXT_HEAD_BYTES = 512 * 1024;

function ImagePreview({ token }: { token: string }) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragging = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "+" || e.key === "=") setZoom((z) => Math.min(8, z * 1.25));
      if (e.key === "-") setZoom((z) => Math.max(0.2, z / 1.25));
      if (e.key === "0") {
        setZoom(1);
        setPan({ x: 0, y: 0 });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div
      className="flex h-full w-full items-center justify-center overflow-hidden"
      onWheel={(e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        setZoom((z) => Math.min(8, Math.max(0.2, z * factor)));
      }}
      onMouseDown={(e) => {
        dragging.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
        const move = (me: MouseEvent) => {
          if (dragging.current) {
            setPan({ x: me.clientX - dragging.current.x, y: me.clientY - dragging.current.y });
          }
        };
        const up = () => {
          dragging.current = null;
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      }}
    >
      <img
        src={previewUrl(token)}
        alt=""
        draggable={false}
        className="max-h-full max-w-full select-none object-contain"
        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
      />
    </div>
  );
}

function TextPreviewView({ entry }: { entry: Entry }) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; text: string; truncated: boolean }
    | { kind: "error"; message: string }
  >({ kind: "loading" });

  useEffect(() => {
    let alive = true;
    setState({ kind: "loading" });
    ipc
      .readTextHead(entry.path, TEXT_HEAD_BYTES)
      .then((tp) => {
        if (alive) setState({ kind: "ready", text: tp.text, truncated: tp.truncated });
      })
      .catch((err) => {
        if (alive) setState({ kind: "error", message: String(err) });
      });
    return () => {
      alive = false;
    };
  }, [entry.path]);

  if (state.kind === "loading") {
    return <div className="flex h-full items-center justify-center text-xs text-tertiary">Loading…</div>;
  }
  if (state.kind === "error") {
    return (
      <div className="flex h-full items-center justify-center text-xs text-danger">
        Couldn't read file: {state.message}
      </div>
    );
  }
  const lines = state.text.split("\n");
  return (
    <div className="h-full w-full overflow-auto rounded-lg bg-pane p-4">
      <pre className="select-text font-mono text-xs leading-[1.5] text-primary">
        {lines.map((line, i) => (
          <div key={i} className="flex">
            <span className="tnum mr-4 w-10 shrink-0 select-none text-right text-tertiary">
              {i + 1}
            </span>
            <span className="whitespace-pre-wrap break-all">{line}</span>
          </div>
        ))}
      </pre>
      {state.truncated && (
        <div className="mt-2 text-center text-[11px] text-tertiary">
          — showing the first 512 KB —
        </div>
      )}
    </div>
  );
}

function FallbackPreview({ entry }: { entry: Entry }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4">
      <img
        src={thumbUrl(entry.icon, 1024)}
        alt=""
        className="max-h-[60vh] max-w-[70vw] object-contain"
        draggable={false}
      />
      <div className="text-center">
        <div className="text-[13px] text-primary">{entryKindLabel(entry)}</div>
        <div className="tnum mt-1 text-xs text-secondary">
          {entry.size != null && `${formatBytes(entry.size)} · `}
          {formatDateFull(entry.mtime)}
        </div>
      </div>
    </div>
  );
}

function PreviewContent({ entry }: { entry: Entry }) {
  const mode = previewModeFor(entry.ext, entry.kind);
  const [token, setToken] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const needsToken = mode === "image" || mode === "video" || mode === "audio";

  useEffect(() => {
    if (!needsToken) return;
    let alive = true;
    let issued: string | null = null;
    setToken(null);
    setTokenError(null);
    ipc
      .registerPreview(entry.path)
      .then((t) => {
        issued = t;
        if (alive) setToken(t);
        else void ipc.revokePreview(t).catch(() => {});
      })
      .catch((err) => {
        if (alive) setTokenError(String(err));
      });
    return () => {
      alive = false;
      if (issued) void ipc.revokePreview(issued).catch(() => {});
    };
  }, [entry.path, needsToken]);

  if (needsToken && tokenError) {
    return <FallbackPreview entry={entry} />;
  }
  if (needsToken && token == null) {
    return <div className="flex h-full items-center justify-center text-xs text-tertiary">Loading…</div>;
  }

  switch (mode) {
    case "image":
      return <ImagePreview token={token as string} />;
    case "video":
      return (
        <div className="flex h-full items-center justify-center">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video src={previewUrl(token as string)} controls autoPlay className="max-h-full max-w-full" />
        </div>
      );
    case "audio":
      return (
        <div className="flex h-full flex-col items-center justify-center gap-6">
          <img src={thumbUrl(entry.icon, 512)} alt="" className="h-40 w-40 object-contain" />
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio src={previewUrl(token as string)} controls autoPlay className="w-[420px]" />
        </div>
      );
    case "text":
      return <TextPreviewView entry={entry} />;
    case "thumbnail":
      return <FallbackPreview entry={entry} />;
  }
}

export function PreviewOverlay() {
  const open = useApp((s) => s.previewOpen);
  const setOpen = useApp((s) => s.setPreviewOpen);
  const activePaneId = useApp((s) => s.activePaneId);
  const pane = usePanes((s) => s.panes.find((p) => p.id === activePaneId) ?? s.panes[0]);
  const tab = pane ? activeTabOf(pane) : null;

  // the list we walk: the selection if >1, else the whole visible dir
  const list = useMemo(() => {
    if (!tab) return [];
    const vis = visibleEntries(tab);
    const sel = vis.filter((e) => tab.selection.selected.has(e.id));
    return sel.length > 1 ? sel : vis;
  }, [tab]);

  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!open || !tab) return;
    const leadId = tab.selection.lead ?? [...tab.selection.selected][0];
    const idx = list.findIndex((e) => e.id === leadId);
    setIndex(idx >= 0 ? idx : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = useCallback(() => setOpen(false), [setOpen]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return; // let ⌘Y etc. through
      switch (e.key) {
        case "Escape":
        case " ":
          e.preventDefault();
          e.stopImmediatePropagation();
          close();
          break;
        case "ArrowRight":
          e.preventDefault();
          e.stopImmediatePropagation();
          setIndex((i) => Math.min(list.length - 1, i + 1));
          break;
        case "ArrowLeft":
          e.preventDefault();
          e.stopImmediatePropagation();
          setIndex((i) => Math.max(0, i - 1));
          break;
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, list.length, close]);

  if (!open) return null;
  const entry = list[index];
  if (!entry) {
    return null;
  }

  return (
    <div
      className="anim-fade fixed inset-0 z-[75] flex flex-col bg-black/60"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="flex h-10 shrink-0 items-center justify-center gap-2 px-4">
        <span className="max-w-[50vw] truncate text-[13px] font-medium text-white">
          {entry.name}
        </span>
        {list.length > 1 && (
          <span className="tnum text-xs text-white/60">
            — {index + 1} of {list.length}
          </span>
        )}
        <button
          className="absolute right-4 cursor-default rounded px-1.5 text-white/60 hover:text-white"
          onClick={close}
          aria-label="Close preview"
        >
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1 px-8 pb-8">
        <PreviewContent key={entry.path} entry={entry} />
      </div>
    </div>
  );
}
