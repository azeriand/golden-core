import { FaRegCircleXmark } from "react-icons/fa6";
import { FiDownload } from "react-icons/fi";
import { Button } from "azeriand-library";
import LikeCounter from "./like-counter";
import useEventStore from "../src/stores/event.store";

export default function ZoomPhoto({ src, likes, mediaID, liked, type, eventSlug, onClose }: { src: string, likes: number, mediaID: number, liked: boolean, type: string | null, eventSlug: string, onClose: () => void }) {
    const { event } = useEventStore();

    // Read current like state from the store so it stays in sync
    const media = event?.sections
        .flatMap((section) => section.media)
        .find((m) => m.media_id === mediaID);

    const likes = media?.likes ?? 0;
    const liked = media?.liked ?? false;

    const handleDownload = async () => {
        const response = await fetch(
            `/api/event/${eventSlug}/media/${mediaID}/download`
        );

        if (!response.ok) {
            console.error("Error downloading media");
            return;
        }

        const blob = await response.blob();

        const url = URL.createObjectURL(blob);

        const link = document.createElement("a");

        link.href = url;
        link.download = `media-${mediaID}`;

        document.body.appendChild(link);
        link.click();
        link.remove();

        URL.revokeObjectURL(url);
    };
    return(
        <article className="fixed inset-0 z-[9999] flex flex-col gap-y-4 p-10 items-center justify-center bg-black/80" style={{backdropFilter: 'blur(5px)', WebkitBackdropFilter: 'blur(5px)', willChange: 'transform'}}>
            <FaRegCircleXmark size={24} className='absolute top-6 right-6 text-white cursor-pointer' onClick={onClose} />
            {type?.startsWith("video/") ? (
                <video
                    src={src}
                    controls
                    className="w-full flex-1 min-h-0 object-contain rounded-md"
                />
            ) : (
                <img
                    src={src}
                    alt="Zoomed Image"
                    className="w-full flex-1 min-h-0 object-contain rounded-md"
                />
            )}
            <section className='flex justify-end gap-4 items-center w-full'>
                <LikeCounter likes={likes} mediaID={mediaID} liked={liked} className='h-full'/>
                <Button onClick={handleDownload}><FiDownload size={20}/></Button>
            </section>
        </article>
    )
}
