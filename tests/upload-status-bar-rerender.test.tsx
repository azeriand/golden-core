// @vitest-environment jsdom
//
// Render-count test — Upload_Status_Bar scoped subscription (Task 4.5).
//
// Verifies that a component subscribing to the Upload_Store via the SAME scoped
// aggregate selector the bar uses — `useUploadStore(useShallow(selectAggregateProgress))`
// — does NOT re-render on a progress-only store tick that leaves the rounded
// aggregate percent / done / total unchanged.
//
//   Validates: Requirements 5.1
//
// The Upload_Store is the single source of truth; `selectAggregateProgress`
// returns a fresh { done, total, percent } object every call, so it must be
// consumed with `useShallow` (a shallow field-by-field comparison) so a progress
// tick that does not change the rounded percent/done/total does not force a
// re-render. We construct exactly such a tick: a single item at progress 40 ->
// 40.4. The arithmetic mean rounds to 40 both times (percent unchanged), and
// done/total are unchanged, so the shallow-equal aggregate must NOT re-render an
// unrelated subscriber.

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useShallow } from "zustand/react/shallow";

import UploadStatusBar from "../app/components/upload-status-bar";
import { selectAggregateProgress } from "../app/components/upload-status";
import useUploadStore, {
  type UploadItem,
  type UploadStatus,
} from "../app/src/stores/upload.store";

// --- store driving helpers ----------------------------------------------------

// Build a minimal UploadItem carrying just the fields the status bar's selectors
// read (`status` for the active/done counts, `progress` for the aggregate mean).
// All other fields are inert placeholders so the shape type-checks; the selector
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

function setItems(items: UploadItem[]) {
  useUploadStore.setState({ items });
}

// An "unrelated subscriber": a component that subscribes to the SAME scoped
// aggregate selector the bar consumes, wrapped in useShallow. It increments a
// module-level render counter on every render/commit so the test can assert
// whether a store tick caused it to re-render.
let unrelatedRenderCount = 0;

function UnrelatedSubscriber(): React.ReactElement {
  // Subscribe exactly as the bar does (Req 5.1): a derived object read through
  // useShallow so equal rounded percent/done/total re-uses the prior snapshot.
  const { done, total, percent } = useUploadStore(
    useShallow(selectAggregateProgress)
  );
  unrelatedRenderCount += 1;
  return (
    <div data-testid="unrelated" data-done={done} data-total={total} data-percent={percent} />
  );
}

afterEach(() => {
  cleanup();
  unrelatedRenderCount = 0;
  // Reset the singleton store so items never leak between tests.
  useUploadStore.setState({ items: [] });
});

describe("UploadStatusBar scoped subscription re-render count (Req 5.1)", () => {
  it("does not re-render an unrelated aggregate subscriber on a progress-only tick that leaves rounded percent/done/total unchanged", () => {
    // Start with a single active item whose progress rounds to 40.
    setItems([makeItem("a", "uploading", 40)]);

    render(
      <>
        <UploadStatusBar />
        <UnrelatedSubscriber />
      </>
    );

    // Record the render count after the initial mount settles.
    const countAfterMount = unrelatedRenderCount;

    // Dispatch a PROGRESS-ONLY tick: 40 -> 40.4. The rounded aggregate percent
    // stays 40, and done (0) / total (1) are unchanged. Because the aggregate is
    // consumed with useShallow, the subscriber must NOT re-render.
    act(() => {
      setItems([makeItem("a", "uploading", 40.4)]);
    });

    expect(unrelatedRenderCount).toBe(countAfterMount);
  });

  it("DOES re-render when the rounded aggregate actually changes (sanity check)", () => {
    setItems([makeItem("a", "uploading", 40)]);

    render(
      <>
        <UploadStatusBar />
        <UnrelatedSubscriber />
      </>
    );

    const countAfterMount = unrelatedRenderCount;

    // A tick that changes the rounded percent (40 -> 60) MUST re-render, proving
    // the no-re-render assertion above is meaningful and not vacuously true.
    act(() => {
      setItems([makeItem("a", "uploading", 60)]);
    });

    expect(unrelatedRenderCount).toBeGreaterThan(countAfterMount);
  });
});
