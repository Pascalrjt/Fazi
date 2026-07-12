/**
 * PDF preview: pdf.js rendered to a canvas, lazy-loaded (~1 MB chunk stays
 * out of the main bundle). Bytes arrive via fetch(preview://token) — needs
 * the CORS echo on preview:// responses plus the worker-src/connect-src CSP
 * entries. PageUp/PageDown (and on-screen arrows) page within the document;
 * ←/→ keep their file-to-file meaning in the overlay.
 */
import { useEffect, useRef, useState } from "react";
import { previewUrl } from "../../types/ipc";

type PdfjsModule = typeof import("pdfjs-dist");
type PdfDocument = import("pdfjs-dist").PDFDocumentProxy;

/** pdf.js requires an explicit worker source; Vite emits the URL. */
function configureWorker(pdfjs: PdfjsModule): void {
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();
}

/** Standard 14 fonts live under public/ (dev and bundled builds serve them). */
const STANDARD_FONTS_URL = "/pdfjs/standard_fonts/";

export function PdfPreview({ token }: { token: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const renderTaskRef = useRef<{ cancel(): void } | null>(null);
  const [doc, setDoc] = useState<PdfDocument | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);

  // Load the document; destroy the loading task on unmount/file change.
  useEffect(() => {
    let alive = true;
    let loadingTask: { destroy(): Promise<unknown> } | null = null;
    setDoc(null);
    setPage(1);
    setError(null);
    void (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        configureWorker(pdfjs);
        const res = await fetch(previewUrl(token));
        if (!res.ok) throw new Error(`couldn't read file (${res.status})`);
        const data = await res.arrayBuffer();
        if (!alive) return;
        const task = pdfjs.getDocument({ data, standardFontDataUrl: STANDARD_FONTS_URL });
        loadingTask = task;
        const document = await task.promise;
        // If the effect was cleaned up mid-load, the loadingTask.destroy()
        // in the cleanup already tore the document down.
        if (!alive) return;
        setDoc(document);
      } catch (err) {
        if (alive) setError(String(err));
      }
    })();
    return () => {
      alive = false;
      renderTaskRef.current?.cancel();
      if (loadingTask) void loadingTask.destroy().catch(() => {});
    };
  }, [token]);

  // Render the current page; cancel any in-flight render first.
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    void (async () => {
      try {
        renderTaskRef.current?.cancel();
        const p = await doc.getPage(page);
        const canvas = canvasRef.current;
        const frame = frameRef.current;
        if (!canvas || !frame || cancelled) return;
        const dpr = window.devicePixelRatio || 1;
        const base = p.getViewport({ scale: 1 });
        const fit = Math.min(
          (frame.clientWidth - 16) / base.width,
          (frame.clientHeight - 16) / base.height,
        );
        const viewport = p.getViewport({ scale: Math.max(0.1, fit) * dpr });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
        canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
        const task = p.render({ canvas, viewport });
        renderTaskRef.current = task;
        // A cancelled render rejects — that's expected, not an error state.
        await task.promise.catch(() => {});
      } catch {
        /* page vanished mid-close */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doc, page]);

  // PageUp/PageDown page within the PDF (←/→ stay file-to-file).
  useEffect(() => {
    if (!doc) return;
    const total = doc.numPages;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "PageDown") {
        e.preventDefault();
        e.stopImmediatePropagation();
        setPage((n) => Math.min(total, n + 1));
      } else if (e.key === "PageUp") {
        e.preventDefault();
        e.stopImmediatePropagation();
        setPage((n) => Math.max(1, n - 1));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [doc]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-danger">
        Couldn't render PDF: {error}
      </div>
    );
  }

  return (
    <div ref={frameRef} className="relative flex h-full w-full items-center justify-center">
      {doc == null ? (
        <div className="text-xs text-tertiary">Loading…</div>
      ) : (
        <canvas ref={canvasRef} className="rounded bg-white shadow-lg" />
      )}
      {doc != null && doc.numPages > 1 && (
        <div className="absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/60 px-3 py-1 text-xs text-white">
          <button
            className="cursor-default px-1 disabled:opacity-40"
            disabled={page <= 1}
            onClick={() => setPage((n) => Math.max(1, n - 1))}
            aria-label="Previous page"
          >
            ▲
          </button>
          <span className="tnum">
            {page} / {doc.numPages}
          </span>
          <button
            className="cursor-default px-1 disabled:opacity-40"
            disabled={page >= doc.numPages}
            onClick={() => setPage((n) => Math.min(doc.numPages, n + 1))}
            aria-label="Next page"
          >
            ▼
          </button>
        </div>
      )}
    </div>
  );
}
