/**
 * PdfPreview smoke test with pdf.js mocked: worker source configured,
 * getDocument fed the fetched bytes + standard-font URL, and the loading
 * task destroyed on unmount (lifecycle contract).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  workerSrc: "",
  getDocumentArgs: [] as Array<Record<string, unknown>>,
  destroyCalls: 0,
  renderCalls: 0,
}));

vi.mock("pdfjs-dist", () => {
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
    render: () => {
      mocks.renderCalls += 1;
      return { promise: Promise.resolve(), cancel: () => {} };
    },
  };
  const doc = {
    numPages: 3,
    getPage: () => Promise.resolve(page),
  };
  return {
    GlobalWorkerOptions: {
      set workerSrc(v: string) {
        mocks.workerSrc = v;
      },
      get workerSrc() {
        return mocks.workerSrc;
      },
    },
    getDocument: (args: Record<string, unknown>) => {
      mocks.getDocumentArgs.push(args);
      return {
        promise: Promise.resolve(doc),
        destroy: () => {
          mocks.destroyCalls += 1;
          return Promise.resolve();
        },
      };
    },
  };
});

import { PdfPreview } from "../PdfPreview";

describe("PdfPreview", () => {
  beforeEach(() => {
    mocks.workerSrc = "";
    mocks.getDocumentArgs.length = 0;
    mocks.destroyCalls = 0;
    mocks.renderCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(16)),
        }),
      ),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("configures the worker, loads via fetch bytes, and destroys on unmount", async () => {
    const { unmount } = render(<PdfPreview token="tok123" />);

    await waitFor(() => {
      expect(mocks.getDocumentArgs).toHaveLength(1);
    });
    // Explicit worker source is mandatory for pdf.js.
    expect(mocks.workerSrc).toContain("pdf.worker");
    // Bytes came from the fetched ArrayBuffer, fonts from public/.
    expect(mocks.getDocumentArgs[0].data).toBeInstanceOf(ArrayBuffer);
    expect(mocks.getDocumentArgs[0].standardFontDataUrl).toBe("/pdfjs/standard_fonts/");
    expect(fetch).toHaveBeenCalledWith("preview://localhost/tok123");

    // Multi-page chrome appears once the doc lands.
    await waitFor(() => {
      expect(screen.getByText("1 / 3")).toBeTruthy();
    });
    await waitFor(() => {
      expect(mocks.renderCalls).toBeGreaterThan(0);
    });

    unmount();
    expect(mocks.destroyCalls).toBe(1);
  });

  it("shows an error state when the bytes can't be fetched", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: false, status: 404 })),
    );
    render(<PdfPreview token="missing" />);
    await waitFor(() => {
      expect(screen.getByText(/Couldn't render PDF/)).toBeTruthy();
    });
    expect(mocks.getDocumentArgs).toHaveLength(0);
  });
});
