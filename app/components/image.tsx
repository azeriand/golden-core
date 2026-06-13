import LikeCounter from "./like-counter";

export default function Image({index, src, likes}: {index: number, src: string, likes: number}) {
    
    return(
        <article key={index} className='w-full h-auto rounded-lg relative'>
            <img src={src} alt={`Masonry Image ${index}`} className='w-full h-auto rounded-lg'/>
            <LikeCounter likes={likes} className='absolute bottom-2 right-2'/>
        </article>
    )
}