// @vitest-environment jsdom
//
// Interaction tests for MediaItem's video poster rendering (Component 7,
// Requirement 12). These verify the three device-consistent behaviors the
// design calls out for the video branch:
//   - poster_url present  -> render <video poster preload="none">   (Req 12.2, 12.3)
//   - poster_url null      -> render placeholder + play overlay      (Req 12.1)
//   - poster fails/timeout -> fall back to the placeholder           (Req 12.5)
//
// The video element stays mounted in every case so the video still plays when
// opened (Req 15.1). We render the real component (no mocking of its logic);
// only the browser DOM is provided by jsdom. next/image and the blurhash canvas
// belong to the image branch and are never exercised here because `type` is a
// video MIME string.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import MediaItem from "../app/components/media-item";

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

// Shared props for a video media item. Only `poster_url` varies per test.
function renderVideo(poster_url: string | null) {
    return render(
        <MediaItem
            index={0}
            src="https://blob.example/video.mp4"
            type="video/mp4"
            poster_url={poster_url}
            likes={0}
            liked={false}
            mediaID={1}
            section_id={null}
            sections={[]}
            blurhash={null}
            username={null}
            onZoom={() => {}}
        />,
    );
}

describe("MediaItem video poster rendering", () => {
    it("renders <video> with poster and preload=none when poster_url is present (Req 12.2, 12.3)", () => {
        renderVideo("https://blob.example/posters/1/poster.jpg");

        const video = screen.getByTestId("poster-video") as HTMLVideoElement;
        // Req 12.2: poster attribute set to the poster_url value.
        expect(video.getAttribute("poster")).toBe("https://blob.example/posters/1/poster.jpg");
        // Req 12.3: preload="none" so no video bytes are fetched to paint a preview.
        expect(video.getAttribute("preload")).toBe("none");
        // Poster-ready state shows no placeholder, but the play overlay stays.
        expect(screen.queryByTestId("poster-placeholder")).toBeNull();
        expect(screen.getByTestId("play-overlay")).toBeTruthy();
    });

    it("renders the placeholder and play overlay when poster_url is null (Req 12.1, 12.4)", () => {
        renderVideo(null);

        // Req 12.1: a placeholder stands in for the (missing) preview frame.
        expect(screen.getByTestId("poster-placeholder")).toBeTruthy();
        // Existing play-button overlay remains visible.
        expect(screen.getByTestId("play-overlay")).toBeTruthy();
        // Req 15.1 / 12.4: the video element is still mounted (plays when opened),
        // and it carries no poster attribute since none is ready.
        const video = screen.getByTestId("poster-video") as HTMLVideoElement;
        expect(video.getAttribute("preload")).toBe("none");
        expect(video.getAttribute("poster")).toBeNull();
    });

    it("falls back to the placeholder when the poster fails to load (Req 12.5)", () => {
        renderVideo("https://blob.example/posters/1/poster.jpg");

        // Initially the poster video is shown (no placeholder).
        const video = screen.getByTestId("poster-video");
        expect(screen.queryByTestId("poster-placeholder")).toBeNull();

        // Simulate the poster image failing to load.
        fireEvent.error(video);

        // Req 12.5: the placeholder is now shown so the slot has a visible element,
        // while the play overlay stays.
        expect(screen.getByTestId("poster-placeholder")).toBeTruthy();
        expect(screen.getByTestId("play-overlay")).toBeTruthy();
    });

    it("falls back to the placeholder when the poster does not load within the timeout (Req 12.5)", () => {
        vi.useFakeTimers();
        renderVideo("https://blob.example/posters/1/poster.jpg");

        // Poster shown initially, no placeholder.
        expect(screen.queryByTestId("poster-placeholder")).toBeNull();

        // Advance past the configured poster-load timeout without a load event.
        // Wrapped in act() so the React state update from the timer callback is
        // flushed synchronously under fake timers.
        act(() => {
            vi.advanceTimersByTime(8000);
        });

        // Req 12.5: the timeout guard trips the placeholder fallback.
        expect(screen.getByTestId("poster-placeholder")).toBeTruthy();
    });

    it("does not fall back when the poster loads before the timeout (Req 12.5)", () => {
        vi.useFakeTimers();
        renderVideo("https://blob.example/posters/1/poster.jpg");

        const video = screen.getByTestId("poster-video");
        // Poster paints successfully (onLoadedData) before the timeout.
        fireEvent.loadedData(video);

        // Advancing past the timeout must NOT trip the fallback because the guard
        // was cleared on successful load.
        act(() => {
            vi.advanceTimersByTime(10000);
        });

        expect(screen.queryByTestId("poster-placeholder")).toBeNull();
        expect(screen.getByTestId("poster-video")).toBeTruthy();
    });
});
