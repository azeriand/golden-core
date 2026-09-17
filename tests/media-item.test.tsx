// @vitest-environment jsdom
//
// Interaction tests for MediaItem's video poster rendering (Component 7,
// Requirement 12). These verify the three device-consistent behaviors the
// design calls out for the video branch:
//   - poster_url present  -> render the poster frame as an <img>      (Req 12.2, 12.3)
//   - poster_url null      -> render placeholder + play overlay        (Req 12.1)
//   - poster fails/timeout -> fall back to the placeholder             (Req 12.5)
//
// The poster is rendered as a real <img> (via next/image), NOT the <video>'s
// `poster` attribute: a <video preload="none"> never fires `loadedData` in a
// real browser (no video bytes are fetched), so the load/timeout guard could
// never clear and the placeholder always won — hiding a poster that had painted.
// An <img> fires onLoad/onError reliably. The <video> is loaded only when the
// zoom viewer opens (Req 15.1). We render the real component (no mocking of its
// logic); only the browser DOM is provided by jsdom.

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
    it("renders the poster frame as an <img> when poster_url is present (Req 12.2, 12.3)", () => {
        renderVideo("https://blob.example/posters/1/poster.jpg");

        const poster = screen.getByTestId("poster-video") as HTMLImageElement;
        // Req 12.2: the poster frame is rendered as an <img> (fires onLoad/onError
        // reliably, unlike a <video preload="none">). next/image rewrites the src
        // through the optimizer, so assert the original URL is referenced rather
        // than matching the exact optimized value.
        expect(poster.tagName).toBe("IMG");
        expect(decodeURIComponent(poster.getAttribute("src") ?? "")).toContain(
            "https://blob.example/posters/1/poster.jpg",
        );
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
        // Req 12.4: no poster <img> is rendered while none is ready; the actual
        // <video> is loaded only when the zoom viewer opens (Req 15.1).
        expect(screen.queryByTestId("poster-video")).toBeNull();
    });

    it("falls back to the placeholder when the poster fails to load (Req 12.5)", () => {
        renderVideo("https://blob.example/posters/1/poster.jpg");

        // Initially the poster image is shown (no placeholder).
        const poster = screen.getByTestId("poster-video");
        expect(screen.queryByTestId("poster-placeholder")).toBeNull();

        // Simulate the poster image failing to load.
        fireEvent.error(poster);

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

    it("does not fall back when the poster loads before the timeout (Req 12.5)", async () => {
        renderVideo("https://blob.example/posters/1/poster.jpg");

        const poster = screen.getByTestId("poster-video");
        // Poster paints successfully (the <img>'s onLoad) before the timeout.
        // next/image invokes the user onLoad asynchronously (after img.decode()
        // resolves), so we await an async act() to flush that microtask and the
        // resulting React state update. Real timers here so the microtask runs.
        await act(async () => {
            fireEvent.load(poster);
        });

        // The load cleared the guard and marked the poster loaded, so the effect
        // no longer arms the timeout. The placeholder fallback must not appear.
        expect(screen.queryByTestId("poster-placeholder")).toBeNull();
        expect(screen.getByTestId("poster-video")).toBeTruthy();
    });
});
