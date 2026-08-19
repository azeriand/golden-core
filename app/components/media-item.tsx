import LikeCounter from "./like-counter";
import { Section } from "../dto/section";

export default function MediaItem({index, src, type, likes, liked, mediaID, section_id, sections, onZoom}: {index: number, src: string, type: string | null, likes: number, liked: boolean, mediaID: number, section_id: number|null, sections: Section[], onZoom: () => void}) {

    return(
        <article key={index} className='w-full h-auto rounded-lg relative'>
            {type?.startsWith("video/") ? (
                <video src={src} controls playsInline preload="metadata" className='w-full h-auto rounded-lg cursor-pointer' onClick={onZoom} />
            ) : (
                <img src={src} alt={`Masonry Image ${index}`} className='w-full h-auto rounded-lg cursor-pointer' onClick={onZoom}/>
            )}
            <LikeCounter likes={likes} mediaID={mediaID} liked={liked} className='absolute bottom-2 right-2'/>
        </article>
    )
}
