import { FaRegCircleXmark } from "react-icons/fa6";
import { FiDownload } from "react-icons/fi";
import { Button } from "azeriand-library";
import LikeCounter from "./like-counter";
import useEventStore from "../src/stores/event.store";
import useMediaUiStore from "../src/stores/media-ui.store";

export default function ZoomPhoto({ src, likes: initialLikes, mediaID, liked: initialLiked, type, eventSlug, onClose }: { src: string, likes: number, mediaID: number, liked: boolean, type: string | null, eventSlug: string, onClose: () => void }) {
    const { event } = useEventStore();
    const { downloading, downloadProgress } = useMediaUiStore();

    // Read current like state from the store so it stays in sync
    const media = event?.sections
        .flatMap((section) => section.media)
        .find((m) => m.media_id === mediaID);

    const likes = media?.likes ?? initialLikes;
    const liked = media?.liked ?? initialLiked;

    const handleDownload = async () => {
        const { downloading } = useMediaUiStore.getState();
        if (downloading) return;

        useMediaUiStore.setState({ downloading: true, downloadProgress: 0 });

        try {
            const response = await fetch(
                `/api/event/${eventSlug}/media/${mediaID}/download`
            );

            if (!response.ok) {
                console.error("Error downloading media");
                return;
            }

            const contentLength = response.headers.get("Content-Length");
            const total = contentLength ? parseInt(contentLength, 10) : 0;

            if (response.body) {
                const reader = response.body.getReader();
                const chunks: Uint8Array[] = [];
                let received = 0;

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    chunks.push(value);
                    received += value.length;
                    if (total > 0) {
                        useMediaUiStore.setState({ downloadProgress: Math.round((received / total) * 100) });
                    } else {
                        const simulated = Math.min(90, Math.round(50 * Math.log10(received / 1024 + 1)));
                        useMediaUiStore.setState({ downloadProgress: simulated });
                    }
                }

                useMediaUiStore.setState({ downloadProgress: 100 });
                const blob = new Blob(chunks);
                const url = URL.createObjectURL(blob);
                const link = document.createElement("a");
                link.href = url;
                link.download = `media-${mediaID}`;
                document.body.appendChild(link);
                link.click();
                link.remove();
                URL.revokeObjectURL(url);
            } else {
                const blob = await response.blob();
                const url = URL.createObjectURL(blob);
                const link = document.createElement("a");
                link.href = url;
                link.download = `media-${mediaID}`;
                document.body.appendChild(link);
                link.click();
                link.remove();
                URL.revokeObjectURL(url);
            }
        } catch (error) {
            console.error("Error downloading media:", error);
        } finally {
            useMediaUiStore.setState({ downloading: false, downloadProgress: 0 });
        }
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
                    alt="Imagen ampliada"
                    className="w-full flex-1 min-h-0 object-contain rounded-md"
                />
            )}
            <section className='flex justify-end gap-4 items-center w-full'>
                <LikeCounter likes={likes} mediaID={mediaID} liked={liked} className='h-full'/>
                <Button onClick={handleDownload}>
                    {downloading ? (
                        <svg width="20" height="20" className="transform -rotate-90">
                            <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.2" />
                            <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                                strokeDasharray={2 * Math.PI * 8}
                                strokeDashoffset={2 * Math.PI * 8 - (downloadProgress / 100) * 2 * Math.PI * 8}
                                className="transition-all duration-200 ease-out"
                            />
                        </svg>
                    ) : (
                        <FiDownload size={20}/>
                    )}
                </Button>
            </section>
        </article>
    )
}
