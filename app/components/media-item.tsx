"use client";

import { useCallback, useState } from "react";
import Image from "next/image";
import LikeCounter from "./like-counter";
import BlurhashCanvas from "./blurhash-canvas";
import { Section } from "../dto/section";
import useMediaUiStore from "../src/stores/media-ui.store";
import { MdOutlineRadioButtonUnchecked } from "react-icons/md";
import { MdOutlineCheckCircleOutline } from "react-icons/md";

export default function MediaItem({index, src, type, likes, liked, mediaID, section_id, sections, blurhash, username, onZoom}: {index: number, src: string, type: string | null, likes: number, liked: boolean, mediaID: number, section_id: number|null, sections: Section[], blurhash: string | null, username: string | null, onZoom: () => void}) {
    const [loaded, setLoaded] = useState(false);
    const [errored, setErrored] = useState(false);
    const [blurhashFailed, setBlurhashFailed] = useState(false);
    // Kept mounted until the image's opacity fade-in completes, so the placeholder
    // stays visible BEHIND the image through the 300ms transition (no flash of the
    // article background). Once the opaque image fully covers it, we unmount it.
    const [fadeComplete, setFadeComplete] = useState(false);

    // Stable identity so BlurhashCanvas's decode effect deps stay [blurhash, width, height, onDecodeError]
    // and it does not re-decode on unrelated re-renders.
    const handleBlurhashDecodeError = useCallback(() => setBlurhashFailed(true), []);

    const isVideo = type?.startsWith("video/");

    const { isSelectionMode, selectedIds, toggleSelected } = useMediaUiStore();

    const selected = selectedIds.has(mediaID);

    const handleClick = () => {
        if (isSelectionMode) {
            toggleSelected(mediaID);
            return;
        }

        onZoom();
    };

    return(
        <article key={index} className='w-full h-auto relative overflow-hidden'>
            
            { isSelectionMode && (
                <div className="absolute top-2 right-2 z-10 w-7 h-7 rounded-full bg-white/20 backdrop-blur-md border border-white/30 text-white flex items-center justify-center cursor-pointer" onClick={() => toggleSelected(mediaID)}>
                    {selected ? <MdOutlineCheckCircleOutline size={20}/> : <MdOutlineRadioButtonUnchecked size={20}/>}
                </div>
            )}

            {isVideo ? (
                <div className="relative cursor-pointer" onClick={handleClick}>
                    <video
                        src={src}
                        playsInline
                        preload="metadata"
                        className="w-full h-auto pointer-events-none transition-all duration-200"
                        style={{ filter: selected ? 'brightness(1.2)' : 'none', opacity: selected ? 0.7 : 1 }}
                    />
                    <div className="absolute inset-0 flex items-center justify-center">
                        <div className="w-10 h-10 rounded-full bg-white/20 backdrop-blur-md border border-white/30 flex items-center justify-center">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21" /></svg>
                        </div>
                    </div>
                </div>
            ) : (
                <>
                    {blurhash && !fadeComplete && !errored && !blurhashFailed && (
                        <BlurhashCanvas
                            blurhash={blurhash}
                            width={32}
                            height={32}
                            className="w-full h-auto absolute inset-0 object-cover"
                            onDecodeError={handleBlurhashDecodeError}
                        />
                    )}
                    <Image
                        src={src}
                        alt={`Imagen ${index}`}
                        width={0}
                        height={0}
                        sizes="50vw"
                        className={`w-full h-auto cursor-pointer transition-opacity duration-300 ${loaded ? 'opacity-100' : 'opacity-0'}`}
                        style={{ width: '100%', height: 'auto' }}
                        onLoad={() => setLoaded(true)}
                        onError={() => setErrored(true)}
                        onTransitionEnd={() => { if (loaded) setFadeComplete(true); }}
                        onClick={handleClick}
                        loading="lazy"
                    />
                </>
            )}
            <div className="absolute bottom-2 left-2 right-2 flex justify-between items-center">
                {username && <span className="text-xs text-white/80 drop-shadow-md">{username}</span>}
                <LikeCounter likes={likes} mediaID={mediaID} liked={liked} className='ml-auto'/>
            </div>
        </article>
    )
}
