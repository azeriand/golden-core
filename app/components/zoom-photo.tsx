import { FaRegCircleXmark } from "react-icons/fa6";
import { FiDownload } from "react-icons/fi";
import { Button } from "azeriand-library";
import LikeCounter from "./like-counter";

export default function ZoomPhoto({ src }: { src: string }) {

    return(
        <article className='flex flex-col gap-y-4 p-10 fixed w-full h-full items-center justify-center bg-black/80 z-50' style={{backdropFilter: 'blur(5px)'}}>
            <FaRegCircleXmark size={24} className='absolute top-6 right-6 text-white cursor-pointer' />
            <img src={src} alt="Zoomed Image" className='w-full h-full object-contain rounded-md'/>
            <section className='flex justify-between items-center w-full'>
                <LikeCounter className='h-full'/>
                <Button><FiDownload size={20}/></Button>
            </section>
        </article>
    )
}