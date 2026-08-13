import LikeCounter from "./like-counter";
import { Section } from "../dto/section";
import ZoomPhoto from "./zoom-photo";
import axios from "axios";
import { useState } from "react";

export default function Image({index, src, likes, liked, mediaID, section_id, sections, onZoom}: {index: number, src: string, likes: number, liked: boolean, mediaID: number, section_id: number|null, sections: Section[], onZoom: () => void}) {

    return(
        <article key={index} className='w-full h-auto rounded-lg relative'>
            <img src={src} alt={`Masonry Image ${index}`} className='w-full h-auto rounded-lg cursor-pointer' onClick={onZoom}/>
            <LikeCounter likes={likes} mediaID={mediaID} liked={liked} className='absolute bottom-2 right-2'/>
        </article>
    )
}