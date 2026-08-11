import { Button } from "azeriand-library"
import { AiOutlineHeart } from "react-icons/ai";
import { AiFillHeart } from "react-icons/ai";
import useEventStore from "../src/stores/event.store";

export default function LikeCounter({ className, likes, liked, mediaID }: { className?: string, likes?: number, mediaID?: number, liked?: boolean }) {
    const { toggleLike } = useEventStore();

    return(
        <Button color='white' size="sm" intensity={500} className={`rounded-md ${className}` } onClick={() => toggleLike(mediaID!)}>
            {liked ? <AiFillHeart className="text-red-500 mr-1" /> : <AiOutlineHeart className="mr-1" />}
            {likes ? likes : 0}
        </Button>
    )
}