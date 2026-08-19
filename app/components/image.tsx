import LikeCounter from "./like-counter";
import { Section } from "../dto/section";
import useMediaUiStore from "../src/stores/media-ui.store";
import { MdOutlineRadioButtonUnchecked } from "react-icons/md";
import { MdOutlineCheckCircleOutline } from "react-icons/md";

export default function Image({index, src, likes, liked, mediaID, type, section_id, sections, onSelect, onZoom}: {index: number, src: string, likes: number, liked: boolean, mediaID: number, type: string | null, section_id: number|null, sections: Section[], selected: boolean, onSelect: () => void, onZoom: () => void}) {

    const { isSelectionMode, selectedIds, toggleSelected } = useMediaUiStore()

    const selected = selectedIds.has(mediaID);

    const handleClick = () => {
        if (isSelectionMode) {
            toggleSelected(mediaID);
            return;
        }

        onZoom();
    };

    return(
        <article key={index} className='w-full h-auto rounded-lg relative'>
            
            { isSelectionMode && (
                <div className="absolute top-2 right-2 z-10 w-7 h-7 rounded-full bg-purple-600 text-white flex items-center justify-center">
                    {selected ? <MdOutlineCheckCircleOutline size={20}/> : <MdOutlineRadioButtonUnchecked size={20}/>}
                </div>
            )}

            {type?.startsWith("video/") ? (
                <video
                    src={src}
                    className="w-full h-auto rounded-lg cursor-pointer"
                    onClick={handleClick}
                    muted
                    playsInline
                />
            ) : (
                <img
                    src={src}
                    alt={`Masonry Image ${index}`}
                    className="w-full h-auto rounded-lg cursor-pointer"
                    onClick={handleClick}
                />
            )}
            <LikeCounter likes={likes} mediaID={mediaID} liked={liked} className='absolute bottom-2 right-2'/>
        </article>
    )
}