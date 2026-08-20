import { Button } from "azeriand-library"
import { TbPhotoUp } from "react-icons/tb";
import { TbPhotoHeart } from "react-icons/tb";
import useGlobalStore from "../src/stores/global.store";

export default function UserNavbar() {

    const { state, changeState } = useGlobalStore();
    const hrClassName = "w-full border-t border-amber-700! p-0 m-0 col-span-6";

    const selectedBarClassname = `transition-transform w-1/2 h-full border-amber-700! border-b-4 absolute bottom-0 left-0`;

    return(
        <nav className="grid grid-cols-12 gap-x-4 items-center justify-center w-full relative">
            <Button appearance='ghost' className="text-amber-700! col-span-6" onClick={() => changeState("myPhotos")}><TbPhotoUp size={20}/> Mis fotos</Button>
            <Button appearance='ghost' className="text-amber-700! col-span-6" onClick={() => changeState("favPhotos")}><TbPhotoHeart size={20}/> Favoritas</Button>
            <div className={selectedBarClassname} style={{ borderBottom: '1px solid black', transform: `translateX(${state === 'favPhotos' ? '100%' : '0'})` }}/>
        </nav>
    )
}