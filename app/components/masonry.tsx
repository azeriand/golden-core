import { Media } from "../dto/media";
import { Section } from "../dto/section";
import Image from "./image";

interface MasonryProps {
    
  images: Media[];
  sections: Section[];
  onZoom?: (media: Media) => void;
}

export default function Masonry({ images, sections, onZoom }: MasonryProps) {

    const [imagesEven, imagesOdd]: Media[][] = [images.filter((_, index) => index % 2 === 0), images.filter((_, index) => index % 2 !== 0)];
    
    //Responsive, 3 columns 
    const [images1, images2, images3] = [images.filter((_, index) => index % 3 === 0), images.filter((_, index) => index % 3 === 1), images.filter((_, index) => index % 3 === 2)];

    return(
        <section className='grid grid-cols-2 gap-2 grid-flow-row'>
            <div className='flex flex-col gap-2'>
                {imagesOdd.map((media: Media, index) => (
                    <Image key={index} index={index} src={media.content} likes={media.likes} mediaID={media.media_id} liked={media.liked} section_id={media.section_id} sections={sections} onZoom={() => onZoom(media)}/>
                ))}
            </div>
            <div className='flex flex-col gap-2'>
                {imagesEven.map((media: Media, index) => (
                    <Image key={index} index={index} src={media.content} likes={media.likes} mediaID={media.media_id} liked={media.liked} section_id={media.section_id} sections={sections} onZoom={() => onZoom(media)}/>
                ))}
            </div>
        </section>
    )
}