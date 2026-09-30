// @vitest-environment jsdom
//
// Render/example tests — Upload_Status_Bar pill markup (Task 4.4).
//
// Verifies the rendered structure of the default-exported `UploadStatusBar`
// component (app/components/upload-status-bar.tsx) in both the ACTIVE and
// COMPLETION phases, plus its positioning/responsive classes. The component is a
// PURE VIEW over the Upload_Store: it derives its phase and view model from
// `store.items` via scoped selectors. So the test drives the real singleton
// store with `useUploadStore.setState({ items })`, moving items between an
// active status (`uploading`) and a no-active status (`success`) to reach each
// phase. All store mutations that trigger a React re-render/effect are wrapped
// in `act()`; the store is reset in `afterEach`.
//
//   Active phase asserts (Req 2.1, 2.4, 3.1, 3.3):
//     - the Progress_Ring is rendered (an <svg> with the two <circle> elements),
//     - the `${percent}%` label is shown inside the ring,
//     - the done-count row "X de Y" is present,
//     - the Spanish warning row is present.
//
//   Completion phase asserts (Req 4.2, 4.3, 3.4):
//     - the checkmark is present (data-testid="upload-status-checkmark"),
//     - the Spanish done message "¡Subida completada!" is present.
//
//   Positioning/responsive asserts (Req 1.4, 1.5, 1.6):
//     - the outer wrapper carries `fixed`, `bottom-4`, and `z-[101]` (layers over
//       the Filter_Pill at z-[100]),
//     - the pill carries `w-full` (full-width on mobile) and `md:w-fit`
//       (content-width on desktop).
//
//   Validates: Requirements 2.1, 2.4, 3.1, 3.3, 3.4, 4.2, 4.3, 1.4, 1.5, 1.6

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";

import UploadStatusBar from "../app/components/upload-status-bar";
import useUploadStore, {
  type UploadItem,
  type UploadStatus,
} from "../app/src/stores/upload.store";

// --- store driving helpers ----------------------------------------------------

// Build a minimal UploadItem carrying just the fields the status bar's selectors
// read (`status` for the active/done counts, `progress` for the aggregate). All
// other fields are inert placeholders so the shape type-checks; the component
// never reads them.
function makeItem(id: string, status: UploadStatus, progress = 0): UploadItem {
  return {
    id,
    file: new File([], `${id}.jpg`, { type: "image/jpeg" }),
    previewUrl: "",
    status,
    progress,
    originalSize: 0,
    processedSize: null,
    contentType: "image/jpeg",
    retryCount: 0,
    error: null,
    abort: null,
    mediaResult: null,
    blurhash: null,
    width: null,
    height: null,
    thumbnailDataUrl: null,
    recovery: null,
    date: "",
    creationTime: null,
    attempt: 0,
  };
}

// Replace the store's items (the only state the bar reads).
function setItems(items: UploadItem[]) {
  useUploadStore.setState({ items });
}

// The outer positioning wrapper is the component's root element.
function outerWrapper(container: HTMLElement): HTMLElement {
  return container.firstChild as HTMLElement;
}

// The pill is the element carrying the data-phase marker (task 3.1/4.3).
function pill(container: HTMLElement): HTMLElement {
  const el = container.querySelector("[data-phase]");
  if (!el) throw new Error("pill element (data-phase) not found");
  return el as HTMLElement;
}

afterEach(() => {
  cleanup();
  // Reset the singleton store so items never leak between tests.
  useUploadStore.setState({ items: [] });
});

describe("UploadStatusBar render — active phase (Req 2.1, 2.4, 3.1, 3.3)", () => {
  it("renders the ring, the percentage inside it, the done-count row, and the Spanish warning", () => {
    setItems([]);
    const { container } = render(<UploadStatusBar />);

    // Enter the active phase: two items, one done (success -> 100) and one
    // in flight at 50 -> mean = 75%, done = 1, total = 2.
    act(() => {
      setItems([
        makeItem("a", "success", 100),
        makeItem("b", "uploading", 50),
      ]);
    });

    const bar = pill(container);
    expect(bar.getAttribute("data-phase")).toBe("active");

    // Progress_Ring present: an <svg> containing the track + fill circles (Req 2.1).
    const svg = bar.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(bar.querySelectorAll("circle").length).toBeGreaterThanOrEqual(2);

    // The percentage label is shown inside the ring (Req 2.4). percent = 75.
    expect(within(bar).getByText("75%")).toBeTruthy();

    // Done-count row "X de Y" (Req 3.1/3.2): "1 de 2".
    expect(within(bar).getByText("1 de 2")).toBeTruthy();

    // Spanish warning row present (Req 3.3).
    expect(
      within(bar).getByText("No cierres ni recargues la página")
    ).toBeTruthy();

    // While active there is no completion checkmark or done message.
    expect(screen.queryByTestId("upload-status-checkmark")).toBeNull();
    expect(screen.queryByText("¡Subida completada!")).toBeNull();
  });
});

describe("UploadStatusBar render — completion phase (Req 4.2, 4.3, 3.4)", () => {
  it("shows the checkmark and the Spanish done message once the run drains", () => {
    setItems([]);
    const { container } = render(<UploadStatusBar />);

    // Go active first so the completion latch can fire (Req 4.1 requires the bar
    // to have been active).
    act(() => {
      setItems([makeItem("a", "uploading", 80)]);
    });
    // Drain to no active uploads -> completion phase.
    act(() => {
      setItems([makeItem("a", "success", 100)]);
    });

    const bar = pill(container);
    expect(bar.getAttribute("data-phase")).toBe("completion");

    // Checkmark present in place of the percentage (Req 4.2).
    expect(screen.getByTestId("upload-status-checkmark")).toBeTruthy();

    // Spanish done message replaces the progress rows (Req 4.3 / 3.4).
    expect(screen.getByText("¡Subida completada!")).toBeTruthy();

    // The active-phase rows are gone.
    expect(
      screen.queryByText("No cierres ni recargues la página")
    ).toBeNull();
  });
});

describe("UploadStatusBar render — positioning & responsive classes (Req 1.4, 1.5, 1.6)", () => {
  it("layers over the Filter_Pill (fixed, bottom-4, z-[101]) and is full-width mobile / content-width desktop", () => {
    setItems([]);
    const { container } = render(<UploadStatusBar />);

    act(() => {
      setItems([makeItem("a", "uploading", 30)]);
    });

    // Outer wrapper: fixed to the bottom and layered above the Filter_Pill
    // (z-[100]) and the z-[99] gradient (Req 1.4).
    const wrapper = outerWrapper(container);
    expect(wrapper.classList.contains("fixed")).toBe(true);
    expect(wrapper.classList.contains("bottom-4")).toBe(true);
    expect(wrapper.classList.contains("z-[101]")).toBe(true);

    // The pill spans full width on mobile (Req 1.5) and sizes to content on
    // desktop (Req 1.6).
    const bar = pill(container);
    expect(bar.classList.contains("w-full")).toBe(true);
    expect(bar.classList.contains("md:w-fit")).toBe(true);
  });
});
