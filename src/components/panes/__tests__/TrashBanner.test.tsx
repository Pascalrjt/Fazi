import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  openSettings: vi.fn(() => Promise.resolve()),
  emptyTrash: vi.fn(),
}));

vi.mock("../../../lib/ipc", () => ({
  openFullDiskAccessSettings: mocks.openSettings,
}));

vi.mock("../../../lib/actions", () => ({
  confirmEmptyTrash: mocks.emptyTrash,
}));

import { TrashBanner } from "../Pane";

describe("TrashBanner", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("does not claim an inaccessible Trash is empty", () => {
    render(
      <TrashBanner
        itemCount={0}
        loading={false}
        error={{ code: "permissionDenied", message: "Operation not permitted" }}
      />,
    );

    expect(screen.getByText("Trash contents unavailable")).toBeTruthy();
    expect(screen.queryByText("The Trash is empty")).toBeNull();
    expect(screen.queryByText("Empty Trash…")).toBeNull();
    fireEvent.click(screen.getByText("Grant access…"));
    expect(mocks.openSettings).toHaveBeenCalledOnce();
  });

  it("does not enable Empty Trash before the listing is known", () => {
    render(<TrashBanner itemCount={0} loading error={null} />);
    expect(screen.getByText("Reading Trash…")).toBeTruthy();
    expect(screen.getByText("Empty Trash…").closest("button")?.disabled).toBe(true);
  });
});
