import { Media } from "../dto/media";
import Image from "./image";
interface MasonryProps {
  images: Media[];
}

export default function Masonry({ images }: MasonryProps) {

    const [imagesEven, imagesOdd]: Media[][] = [images.filter((_, index) => index % 2 === 0), images.filter((_, index) => index % 2 !== 0)];
    
    //Responsive, 3 columns 
    const [images1, images2, images3] = [images.filter((_, index) => index % 3 === 0), images.filter((_, index) => index % 3 === 1), images.filter((_, index) => index % 3 === 2)];

    return(
        <section className='grid grid-cols-2 gap-2 grid-flow-row'>
            <div className='flex flex-col gap-2'>
                {imagesOdd.map((media: Media, index) => (
                    <Image key={index} index={index} src={media.content} likes={media.likes} />
                ))}
            </div>
            <div className='flex flex-col gap-2'>
                {imagesEven.map((media: Media, index) => (
                    <Image key={index} index={index} src={media.content} likes={media.likes} />
                ))}
            </div>
        </section>
    )
}