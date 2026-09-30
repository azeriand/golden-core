// @vitest-environment jsdom
//
// Unit test — Upload_Status_Bar 5s auto-hide timer (Task 3.3).
//
// Verifies the presentation-only completion lifecycle of the default-exported
// `UploadStatusBar` component (app/components/upload-status-bar.tsx) using
// Vitest fake timers + Testing Library `render`:
//
//   - Enter completion (active -> no active), advance the full AUTO_HIDE_DELAY_MS
//     ⇒ the bar hides (the component returns null / renders nothing).
//   - Advance LESS than the delay ⇒ the bar is still visible (completion phase).
//   - Re-entry: a new Active_Upload arriving DURING completion cancels the
//     pending auto-hide, so the bar stays visible past the original 5s deadline.
//
//   Validates: Requirements 4.5, 4.6
//
// The component is a PURE VIEW over the Upload_Store: it derives its Active_Upload
// count from `store.items` via the scoped selectors. So the test drives the real
// singleton store with `useUploadStore.setState({ items })`, moving items between
// an active status (`uploading`) and a no-active status (`success`) to trigger
// the active -> completion -> hidden lifecycle. We assert on VISIBILITY semantics
// (a container element is present vs the component renders nothing) rather than
// on the ring/text markup, which a concurrent task fills in — this keeps the
// test robust to that UI work.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

import UploadStatusBar, {
  AUTO_HIDE_DELAY_MS,
} from "../app/components/upload-status-bar";
import useUploadStore, {
  type UploadItem,
  type UploadStatus,
} from "../app/src/stores/upload.store";

// --- store driving helpers ----------------------------------------------------

// Build a minimal UploadItem carrying just the fields the status bar's selectors
// read (`status` for the active/done counts, `progress` for the aggregate). All
// other fields are filled with inert placeholders so the shape type-checks; the
// component never reads them.
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

// Replace the store's items (the only state the bar reads). Wrapped in act() by
// callers so the resulting React re-render/effect is flushed synchronously.
function setItems(items: UploadItem[]) {
  useUploadStore.setState({ items });
}

// True when the rendered bar is showing SOMETHING (visible). The component
// returns null while hidden, so `container.firstChild === null` means hidden.
function isVisible(container: HTMLElement): boolean {
  return container.firstChild !== null;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  // Reset the singleton store so items never leak between tests.
  useUploadStore.setState({ items: [] });
});

describe("UploadStatusBar 5s auto-hide timer (Req 4.5, 4.6)", () => {
  it("hides after AUTO_HIDE_DELAY_MS once it enters completion (Req 4.5)", () => {
    vi.useFakeTimers();
    // Start with no items -> the bar mounts hidden.
    setItems([]);
    const { container } = render(<UploadStatusBar />);
    expect(isVisible(container)).toBe(false);

    // An active upload appears -> phase becomes "active" (visible).
    act(() => {
      setItems([makeItem("a", "uploading", 40)]);
    });
    expect(isVisible(container)).toBe(true);

    // The upload finishes (no active statuses remain) -> phase "completion",
    // still visible, and the 5s auto-hide timer is armed.
    act(() => {
      setItems([makeItem("a", "success", 100)]);
    });
    expect(isVisible(container)).toBe(true);

    // Advance the FULL auto-hide delay -> the bar hides (renders nothing).
    act(() => {
      vi.advanceTimersByTime(AUTO_HIDE_DELAY_MS);
    });
    expect(isVisible(container)).toBe(false);
  });

  it("stays visible while less than AUTO_HIDE_DELAY_MS has elapsed (Req 4.5)", () => {
    vi.useFakeTimers();
    setItems([]);
    const { container } = render(<UploadStatusBar />);

    act(() => {
      setItems([makeItem("a", "uploading", 10)]);
    });
    act(() => {
      setItems([makeItem("a", "success", 100)]);
    });
    expect(isVisible(container)).toBe(true);

    // Just short of the delay -> still in completion, still visible.
    act(() => {
      vi.advanceTimersByTime(AUTO_HIDE_DELAY_MS - 1);
    });
    expect(isVisible(container)).toBe(true);
  });

  it("re-entry during completion cancels the pending hide and keeps the bar visible (Req 4.6)", () => {
    vi.useFakeTimers();
    setItems([]);
    const { container } = render(<UploadStatusBar />);

    // active -> completion (arms the 5s timer).
    act(() => {
      setItems([makeItem("a", "uploading", 50)]);
    });
    act(() => {
      setItems([makeItem("a", "success", 100)]);
    });
    expect(isVisible(container)).toBe(true);

    // Partway through the completion window, a NEW active upload appears. This
    // re-entry must return the bar to "active" and CANCEL the pending auto-hide.
    act(() => {
      vi.advanceTimersByTime(AUTO_HIDE_DELAY_MS - 1000);
    });
    act(() => {
      setItems([makeItem("a", "success", 100), makeItem("b", "uploading", 0)]);
    });
    expect(isVisible(container)).toBe(true);

    // Advance well past the ORIGINAL 5s deadline. If the pending hide had not
    // been canceled, the bar would have hidden here; it must remain visible
    // because a new batch is active.
    act(() => {
      vi.advanceTimersByTime(AUTO_HIDE_DELAY_MS);
    });
    expect(isVisible(container)).toBe(true);
  });
});
