import { Button } from "azeriand-library"
import { TbPhotoUp } from "react-icons/tb";
import { TbPhotoHeart } from "react-icons/tb";
import useGlobalStore from "../src/stores/global.store";

export default function UserNavbar() {

    const { changeState } = useGlobalStore();

    return(
        <nav className="grid grid-cols-12 gap-x-4 items-center justify-center w-full">
            <Button appearance='ghost' className="text-amber-700! col-span-6" onClick={() => changeState("myPhotos")}><TbPhotoUp size={20}/> My photos</Button>
            <Button appearance='ghost' className="text-amber-700! col-span-6" onClick={() => changeState("favPhotos")}><TbPhotoHeart size={20}/> Liked</Button>
            <hr className='w-full border-t border-amber-700! p-0 m-0 col-span-6'/>
            <hr className='w-full border-t border-amber-700! p-0 m-0 col-span-6'/>
        </nav>
    )
}