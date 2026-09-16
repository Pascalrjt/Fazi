import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import * as ipc from "../../../lib/ipc";
import { useDownloadsCleanup } from "../../../stores/downloadsCleanup";
import { CleanupIndicator } from "../CleanupIndicator";
import { DownloadsPane } from "../../settings/DownloadsPane";
import {
  CLEANUP_DAY as DAY,
  type CleanupSnapshot,
} from "../../../lib/downloadsCleanup";
vi.mock("../../../lib/ipc", () => ({
  downloadsCleanupStatus: vi.fn(),
  downloadsCleanupPreview: vi.fn(),
  downloadsCleanupApply: vi.fn(),
  downloadsCleanupDisable: vi.fn(),
  downloadsCleanupItem: vi.fn(),
}));
const now = Date.now();
const snapshot: CleanupSnapshot = {
  config: { enabled: false, retentionDays: 30 },
  root: "/Users/test/Downloads",
  items: [
    {
      name: "report.pdf",
      path: "/Users/test/Downloads/report.pdf",
      identity: "1",
      size: 100,
      modified: now - 40 * DAY,
      added: now - 40 * DAY,
      deadline: now - 10 * DAY,
      keep: false,
    },
  ],
  history: [],
  lastRun: null,
  error: null,
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ipc.downloadsCleanupStatus).mockResolvedValue(snapshot);
  useDownloadsCleanup.getState().accept(snapshot);
});
afterEach(cleanup);
describe("Downloads cleanup UI", () => {
  it("hides indicators until enabled and only renders tracked files", () => {
    const { rerender } = render(
      <CleanupIndicator path={snapshot.items[0].path} />,
    );
    expect(screen.queryByText("Pending cleanup")).toBeNull();
    useDownloadsCleanup
      .getState()
      .accept({ ...snapshot, config: { enabled: true, retentionDays: 30 } });
    rerender(<CleanupIndicator path={snapshot.items[0].path} />);
    expect(screen.getByText("Pending cleanup").className).toContain(
      "text-warning",
    );
    rerender(<CleanupIndicator path="/Users/test/Documents/report.pdf" />);
    expect(screen.queryByText("Pending cleanup")).toBeNull();
  });
  it("requires a reviewed preview before applying an enabled policy", async () => {
    const enabled = {
      ...snapshot,
      config: { enabled: true, retentionDays: 30 },
    };
    vi.mocked(ipc.downloadsCleanupPreview).mockResolvedValue({
      token: "review-token",
      snapshot: enabled,
    });
    vi.mocked(ipc.downloadsCleanupApply).mockResolvedValue(enabled);
    render(<DownloadsPane />);
    await waitFor(() => expect(ipc.downloadsCleanupStatus).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("switch"));
    expect(ipc.downloadsCleanupApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Preview changes"));
    await screen.findByText(/1 file already eligible/);
    expect(ipc.downloadsCleanupApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Apply settings"));
    await waitFor(() =>
      expect(ipc.downloadsCleanupApply).toHaveBeenCalledWith("review-token"),
    );
  });
  it("invalidates a preview when the retention period changes", async () => {
    vi.mocked(ipc.downloadsCleanupPreview).mockResolvedValue({
      token: "old-token",
      snapshot: { ...snapshot, config: { enabled: true, retentionDays: 30 } },
    });
    render(<DownloadsPane />);
    await waitFor(() => expect(ipc.downloadsCleanupStatus).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(screen.getByText("Preview changes"));
    await screen.findByText("Apply settings");
    fireEvent.change(screen.getByLabelText("Retention days"), {
      target: { value: "7" },
    });
    expect(screen.queryByText("Apply settings")).toBeNull();
    expect(ipc.downloadsCleanupApply).not.toHaveBeenCalled();
  });
});
