import { Media } from "../dto/media";
import { Section } from "../dto/section";
import MediaItem from "./media-item";
import useUploadStore from "../src/stores/upload.store";
import { useShallow } from "zustand/react/shallow";
import MediaItemPlaceholder from "./media-item-placeholder";

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

    const [imagesEven, imagesOdd]: Media[][] = [images.filter((_, index) => index % 2 === 0), images.filter((_, index) => index % 2 !== 0)];

    return(
        <section className='grid grid-cols-2 gap-1 grid-flow-row'>
            <div className='flex flex-col gap-1'>
                {placeholdersOdd.map((id: string) => (
                    <MediaItemPlaceholder
                        key={id}
                        id={id}
                        onRetry={retryItem}
                        onRetryConfirm={retryConfirm}
                        onDismiss={dismissItem}
                    />
                ))}
                {imagesOdd.map((media: Media, index) => (
                    <MediaItem key={media.media_id} index={index} src={media.content} type={media.type} likes={media.likes} mediaID={media.media_id} liked={media.liked} section_id={media.section_id} sections={sections} blurhash={media.blurhash} username={media.username} onZoom={() => onZoom(media)}/>
                ))}
            </div>
            <div className='flex flex-col gap-1'>
                {placeholdersEven.map((id: string) => (
                    <MediaItemPlaceholder
                        key={id}
                        id={id}
                        onRetry={retryItem}
                        onRetryConfirm={retryConfirm}
                        onDismiss={dismissItem}
                    />
                ))}
                {imagesEven.map((media: Media, index) => (
                    <MediaItem key={media.media_id} index={index} src={media.content} type={media.type} likes={media.likes} mediaID={media.media_id} liked={media.liked} section_id={media.section_id} sections={sections} blurhash={media.blurhash} username={media.username} onZoom={() => onZoom(media)}/>
                ))}
            </div>
        </section>
    )
}
