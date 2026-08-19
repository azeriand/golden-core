import { FaRegCircleXmark } from "react-icons/fa6";
import { FiDownload } from "react-icons/fi";
import { Button } from "azeriand-library";
import LikeCounter from "./like-counter";

export default function ZoomPhoto({ src, likes, mediaID, liked, onClose }: { src: string, likes: number, mediaID: number, liked: boolean, onClose: () => void }) {

    return(
        <article className="fixed inset-0 z-[9999] flex flex-col gap-y-4 p-10 items-center justify-center bg-black/80" style={{backdropFilter: 'blur(5px)', WebkitBackdropFilter: 'blur(5px)', willChange: 'transform'}}>
            <FaRegCircleXmark size={24} className='absolute top-6 right-6 text-white cursor-pointer' onClick={onClose} />
            <img src={src} alt="Zoomed Image" className="w-full flex-1 min-h-0 object-contain rounded-md"/>
            <section className='flex justify-end gap-4 items-center w-full'>
                <LikeCounter likes={likes} mediaID={mediaID} liked={liked} className='h-full'/>
                <Button><FiDownload size={20}/></Button>
            </section>
        </article>
    )
}