import { Button } from "azeriand-library"
import { AiOutlineHeart } from "react-icons/ai";

export default function LikeCounter({ className, likes }: { className?: string, likes?: number }) {
    return(
        <Button color='white' size="sm" intensity={500} className={`rounded-md ${className}`}>
            <AiOutlineHeart />
            {likes ? likes : 0}
        </Button>
    )
}