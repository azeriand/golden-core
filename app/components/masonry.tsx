"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Media } from "../dto/media";
import { Section } from "../dto/section";
import MediaItem from "./media-item";
import useUploadStore from "../src/stores/upload.store";
import { useShallow } from "zustand/react/shallow";
import MediaItemPlaceholder from "./media-item-placeholder";
import { computeLayout, LayoutInput } from "../../lib/masonry-layout";

const GRID_GAP = 4; // px; matches the Tailwind gap-1 used elsewhere.

interface MasonryProps {
  images: Media[];
  sections: Section[];
  onZoom: (media: Media) => void;
  /**
   * Whether THIS Masonry instance renders the (global) upload placeholders.
   * Placeholders come from the upload store and are shared, so they must be
   * rendered in exactly ONE place — otherwise a page with multiple sections
   * would show duplicate placeholders. The page renders a single dedicated
   * placeholder host (see UploadPlaceholders) so per-section Masonry instances
   * pass `showPlaceholders={false}`. Defaults to true for back-compat.
   */
  showPlaceholders?: boolean;
}

/**
 * Standalone two-column host for the global upload placeholders. Rendered by the
 * page whenever there are pending uploads, so placeholders appear INSTANTLY on
 * enqueue — independent of whether any gallery section currently has media in
 * the active view. Previously placeholders only lived inside a per-section
 * Masonry, so if the target/filtered section had no media its Masonry was not
 * rendered and the placeholders had nowhere to appear until an upload completed.
 */
export function UploadPlaceholders() {
    const placeholderIds = useUploadStore(
        useShallow((state) =>
            state.items.filter((i) => i.status !== "success").map((i) => i.id)
        )
    );
    const retryItem = useUploadStore((state) => state.retryItem);
    const retryConfirm = useUploadStore((state) => state.retryConfirm);
    const dismissItem = useUploadStore((state) => state.dismissItem);

    if (placeholderIds.length === 0) return null;

    const odd = placeholderIds.filter((_, i) => i % 2 !== 0);
    const even = placeholderIds.filter((_, i) => i % 2 === 0);

    return (
        <section className='grid grid-cols-2 gap-1 grid-flow-row w-full'>
            <div className='flex flex-col gap-1'>
                {odd.map((id) => (
                    <MediaItemPlaceholder key={id} id={id} onRetry={retryItem} onRetryConfirm={retryConfirm} onDismiss={dismissItem} />
                ))}
            </div>
            <div className='flex flex-col gap-1'>
                {even.map((id) => (
                    <MediaItemPlaceholder key={id} id={id} onRetry={retryItem} onRetryConfirm={retryConfirm} onDismiss={dismissItem} />
                ))}
            </div>
        </section>
    );
}

export default function Masonry({ images, sections, onZoom, showPlaceholders = true }: MasonryProps) {
    // Subscribe ONLY to the ordered list of placeholder ids (items not yet
    // 'success'), stabilized with useShallow so masonry re-renders ONLY when the
    // set/order of placeholder ids changes (an item added, removed, or crossing
    // into 'success') — NOT on every progress tick. A progress update to a
    // single item does not change this string[], so useShallow returns the
    // previous array reference and masonry does not re-render. When
    // showPlaceholders is false, this instance renders no placeholders (an empty
    // list), so the subscription result is stable and cheap.
    const placeholderIds = useUploadStore(
        useShallow((state) =>
            showPlaceholders
                ? state.items.filter((i) => i.status !== "success").map((i) => i.id)
                : []
        )
    );
    // Function refs are stable across store updates, so selecting them
    // individually does not cause re-renders.
    const retryItem = useUploadStore((state) => state.retryItem);
    const retryConfirm = useUploadStore((state) => state.retryConfirm);
    const dismissItem = useUploadStore((state) => state.dismissItem);

    // Distribute placeholders between two columns (odd/even pattern) — identical
    // ordering/placement to before, now keyed off the id list.
    const placeholdersOdd = placeholderIds.filter((_, index) => index % 2 !== 0);
    const placeholdersEven = placeholderIds.filter((_, index) => index % 2 === 0);

    // --- Segmented justified layout -------------------------------------------
    // Measure the container width so the layout engine can justify each row to
    // fill it exactly. A ResizeObserver keeps this in sync on rotation/resize.
    const containerRef = useRef<HTMLDivElement>(null);
    const [containerWidth, setContainerWidth] = useState(0);
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const update = () => setContainerWidth(el.clientWidth);
        update();
        const ro = new ResizeObserver(update);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // Measured aspect ratios (w/h) keyed by media_id. Seeded empty; each cell
    // reports its real aspect on load, which re-justifies the affected rows.
    // Kept in a ref-backed state so a measurement only re-renders when the value
    // actually changes (avoids a render loop from repeated identical loads).
    const [aspects, setAspects] = useState<Record<number, number>>({});
    const onAspectMeasured = useCallback((id: number, aspect: number) => {
        setAspects((prev) => {
            const existing = prev[id];
            // Ignore if unchanged within a small epsilon (identical reloads).
            if (existing && Math.abs(existing - aspect) < 0.001) return prev;
            return { ...prev, [id]: aspect };
        });
    }, []);

    const layoutInputs: LayoutInput[] = useMemo(
        () =>
            images.map((m) => {
                // Prefer the persisted intrinsic dimensions (migration 005): they
                // are known before the media loads, so the layout is stable with
                // no shift. Fall back to the on-load measured aspect, then to the
                // engine's default when neither is available (legacy rows, videos
                // without measured posters).
                const dbAspect =
                    m.width && m.height && m.width > 0 && m.height > 0
                        ? m.width / m.height
                        : null;
                return { key: m.media_id, aspect: dbAspect ?? aspects[m.media_id] ?? null };
            }),
        [images, aspects],
    );

    const cells = useMemo(
        () => computeLayout(layoutInputs, { containerWidth, gap: GRID_GAP }),
        [layoutInputs, containerWidth],
    );

    // Group computed cells by their row index so each row is a flex line.
    const rows = useMemo(() => {
        const byRow: { row: number; cells: typeof cells }[] = [];
        for (const cell of cells) {
            const last = byRow[byRow.length - 1];
            if (last && last.row === cell.row) last.cells.push(cell);
            else byRow.push({ row: cell.row, cells: [cell] });
        }
        return byRow;
    }, [cells]);

    const mediaById = useMemo(() => {
        const map = new Map<number, Media>();
        images.forEach((m) => map.set(m.media_id, m));
        return map;
    }, [images]);

    return (
        <div className='flex flex-col gap-1 w-full'>
            {placeholderIds.length > 0 && (
                <section className='grid grid-cols-2 gap-1 grid-flow-row'>
                    <div className='flex flex-col gap-1'>
                        {placeholdersOdd.map((id: string) => (
                            <MediaItemPlaceholder key={id} id={id} onRetry={retryItem} onRetryConfirm={retryConfirm} onDismiss={dismissItem} />
                        ))}
                    </div>
                    <div className='flex flex-col gap-1'>
                        {placeholdersEven.map((id: string) => (
                            <MediaItemPlaceholder key={id} id={id} onRetry={retryItem} onRetryConfirm={retryConfirm} onDismiss={dismissItem} />
                        ))}
                    </div>
                </section>
            )}

            {/* Justified segmented gallery. Each row is a flex line whose children
                are sized by the layout engine; rows fill the container width with
                no ragged vertical gaps. The container width is measured once and
                on resize; before it is known (0) no rows render, then they appear
                on the first measured frame. */}
            <section ref={containerRef} className='flex flex-col gap-1 w-full'>
                {rows.map((line, rowIndex) => (
                    <div key={rowIndex} className='flex gap-1'>
                        {line.cells.map((cell) => {
                            const media = mediaById.get(cell.key as number);
                            if (!media) return null;
                            // Size each cell with flex-grow proportional to its
                            // computed width and a 0 basis, so the browser
                            // distributes the row width (minus gaps) exactly —
                            // avoiding sub-pixel overflow that fixed px widths
                            // would cause. Height is fixed to keep the row's
                            // bottom edge flush.
                            return (
                                <div
                                    key={media.media_id}
                                    className='min-w-0'
                                    style={{
                                        flexGrow: cell.fullWidth ? 1 : cell.width,
                                        flexBasis: 0,
                                        height: `${cell.height}px`,
                                    }}
                                >
                                    <MediaItem
                                        index={media.media_id}
                                        src={media.content}
                                        type={media.type}
                                        poster_url={media.poster_url}
                                        likes={media.likes}
                                        mediaID={media.media_id}
                                        liked={media.liked}
                                        section_id={media.section_id}
                                        sections={sections}
                                        blurhash={media.blurhash}
                                        username={media.username}
                                        onZoom={() => onZoom(media)}
                                        displayHeight={cell.height}
                                        onAspectMeasured={(aspect) => onAspectMeasured(media.media_id, aspect)}
                                    />
                                </div>
                            );
                        })}
                    </div>
                ))}
            </section>
        </div>
    );
}
