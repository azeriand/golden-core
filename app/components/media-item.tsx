import LikeCounter from "./like-counter";
import { Section } from "../dto/section";
import useMediaUiStore from "../src/stores/media-ui.store";
import { MdOutlineRadioButtonUnchecked } from "react-icons/md";
import { MdOutlineCheckCircleOutline } from "react-icons/md";

export default function MediaItem({index, src, type, likes, liked, mediaID, section_id, sections, onZoom}: {index: number, src: string, type: string | null, likes: number, liked: boolean, mediaID: number, section_id: number|null, sections: Section[], onZoom: () => void}) {
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
        <article key={index} className='w-full h-auto relative'>
            
            { isSelectionMode && (
                <div className="absolute top-2 right-2 z-10 w-7 h-7 rounded-full bg-purple-600 text-white flex items-center justify-center">
                    {selected ? <MdOutlineCheckCircleOutline size={20}/> : <MdOutlineRadioButtonUnchecked size={20}/>}
                </div>
            )}

            {type?.startsWith("video/") ? (
                <video
                    src={src}
                    controls
                    playsInline
                    preload="metadata"
                    className="w-full h-auto cursor-pointer"
                    onClick={handleClick}
                />
            ) : (
                <img
                    src={src}
                    alt={`Imagen ${index}`}
                    className="w-full h-auto cursor-pointer"
                    onClick={handleClick}
                />
            )}
            <LikeCounter likes={likes} mediaID={mediaID} liked={liked} className='absolute bottom-2 right-2'/>
        </article>
    )
}
