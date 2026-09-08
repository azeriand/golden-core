import { Button } from "azeriand-library"
import { AiOutlineHeart } from "react-icons/ai";
import { AiFillHeart } from "react-icons/ai";
import useEventStore from "../src/stores/event.store";
import { useState } from "react";

export default function LikeCounter({ className, likes, liked, mediaID }: { className?: string, likes?: number, mediaID?: number, liked?: boolean }) {
    const { toggleLike } = useEventStore();
    const [animating, setAnimating] = useState(false);
    const [pending, setPending] = useState(false);

    const handleClick = async () => {
        if (pending) return;

        setPending(true);
        setAnimating(true);
        setTimeout(() => setAnimating(false), 300);

        try {
            await toggleLike(mediaID!);
        } finally {
            setPending(false);
        }
    };

    return(
        <Button color='white' size="sm" intensity={500} className={`rounded-md ${pending ? 'pointer-events-none opacity-70' : ''} ${className}` } onClick={handleClick}>
            <span className={`inline-flex items-center transition-transform duration-300 ${animating ? 'scale-125' : 'scale-100'}`}>
                {liked ? <AiFillHeart className="text-red-500 mr-1" /> : <AiOutlineHeart className="mr-1" />}
            </span>
            {likes ? likes : 0}
        </Button>
    )
}
