import LikeCounter from "./like-counter";
import { Section } from "../dto/section";

export default function Image({index, src, likes, liked, mediaID, type, section_id, sections, onZoom}: {index: number, src: string, likes: number, liked: boolean, mediaID: number, type: string | null, section_id: number|null, sections: Section[], onZoom: () => void}) {

    return(
        <article key={index} className='w-full h-auto rounded-lg relative'>
            {type?.startsWith("video/") ? (
                <video
                    src={src}
                    className="w-full h-auto rounded-lg cursor-pointer"
                    onClick={onZoom}
                    muted
                    playsInline
                />
            ) : (
                <img
                    src={src}
                    alt={`Masonry Image ${index}`}
                    className="w-full h-auto rounded-lg cursor-pointer"
                    onClick={onZoom}
                />
            )}
            <LikeCounter likes={likes} mediaID={mediaID} liked={liked} className='absolute bottom-2 right-2'/>
        </article>
    )
}