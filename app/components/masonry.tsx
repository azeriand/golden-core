import { Media } from "../dto/media";
import { Section } from "../dto/section";
import MediaItem from "./media-item";
import useUploadStore, { UploadItem } from "../src/stores/upload.store";
import MediaItemPlaceholder from "./media-item-placeholder";

interface MasonryProps {
  images: Media[];
  sections: Section[];
  onZoom: (media: Media) => void;
}

export default function Masonry({ images, sections, onZoom }: MasonryProps) {
    const uploadingItems = useUploadStore((state) => state.items);
    const retryItem = useUploadStore((state) => state.retryItem);
    const dismissItem = useUploadStore((state) => state.dismissItem);

    // Filter uploading items to show only non-success items as placeholders
    const activePlaceholders = uploadingItems.filter(
        (item) => item.status !== "success"
    );

    // Distribute placeholders between two columns (odd/even pattern)
    const placeholdersOdd = activePlaceholders.filter((_, index) => index % 2 !== 0);
    const placeholdersEven = activePlaceholders.filter((_, index) => index % 2 === 0);

    const [imagesEven, imagesOdd]: Media[][] = [images.filter((_, index) => index % 2 === 0), images.filter((_, index) => index % 2 !== 0)];

    return(
        <section className='grid grid-cols-2 gap-2 grid-flow-row'>
            <div className='flex flex-col gap-2'>
                {placeholdersOdd.map((item: UploadItem) => (
                    <MediaItemPlaceholder
                        key={item.id}
                        item={item}
                        onRetry={retryItem}
                        onDismiss={dismissItem}
                    />
                ))}
                {imagesOdd.map((media: Media, index) => (
                    <MediaItem key={index} index={index} src={media.content} type={media.type} likes={media.likes} mediaID={media.media_id} liked={media.liked} section_id={media.section_id} sections={sections} blurhash={media.blurhash} username={media.username} onZoom={() => onZoom(media)}/>
                ))}
            </div>
            <div className='flex flex-col gap-2'>
                {placeholdersEven.map((item: UploadItem) => (
                    <MediaItemPlaceholder
                        key={item.id}
                        item={item}
                        onRetry={retryItem}
                        onDismiss={dismissItem}
                    />
                ))}
                {imagesEven.map((media: Media, index) => (
                    <MediaItem key={index} index={index} src={media.content} type={media.type} likes={media.likes} mediaID={media.media_id} liked={media.liked} section_id={media.section_id} sections={sections} blurhash={media.blurhash} username={media.username} onZoom={() => onZoom(media)}/>
                ))}
            </div>
        </section>
    )
}
