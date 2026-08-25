"use client";

import { useState } from "react";
import LikeCounter from "./like-counter";
import BlurhashCanvas from "./blurhash-canvas";
import { Section } from "../dto/section";
import useMediaUiStore from "../src/stores/media-ui.store";
import { MdOutlineRadioButtonUnchecked } from "react-icons/md";
import { MdOutlineCheckCircleOutline } from "react-icons/md";

export default function MediaItem({index, src, type, likes, liked, mediaID, section_id, sections, blurhash, onZoom}: {index: number, src: string, type: string | null, likes: number, liked: boolean, mediaID: number, section_id: number|null, sections: Section[], blurhash: string | null, onZoom: () => void}) {
    const [loaded, setLoaded] = useState(false);

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
                <video
                    src={src}
                    controls
                    playsInline
                    preload="metadata"
                    className="w-full h-auto cursor-pointer"
                    onClick={handleClick}
                />
            ) : (
                <>
                    {blurhash && !loaded && (
                        <BlurhashCanvas
                            blurhash={blurhash}
                            width={32}
                            height={32}
                            className="w-full h-auto absolute inset-0 object-cover"
                        />
                    )}
                    <img
                        src={src}
                        alt={`Imagen ${index}`}
                        className={`w-full h-auto cursor-pointer transition-opacity duration-300 ${loaded ? 'opacity-100' : 'opacity-0'}`}
                        onLoad={() => setLoaded(true)}
                        onClick={handleClick}
                    />
                </>
            )}
            <LikeCounter likes={likes} mediaID={mediaID} liked={liked} className='absolute bottom-2 right-2'/>
        </article>
    )
}
