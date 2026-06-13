import { Card, Button } from "azeriand-library"
import useGlobalStore from "../src/stores/global.store";
import { AiFillHome } from "react-icons/ai";
import { TbPhotoPlus } from "react-icons/tb";
import { PiFolderUserBold } from "react-icons/pi";


export default function Navbar() {

    const { changeState } = useGlobalStore();

    return(
        <Card noPadding color='white' intensity={200} className="flex justify-center gap-x-10 fixed bottom-4 left-4 right-4 border-t p-4 rounded-xl">
            <Button appearance='ghost' color="purple" intensity={700} className="rounded-lg" icon={<AiFillHome size={32}/>} style={{ color: '#9D7BD6' }} onClick={() => changeState("home")}/>
            <Button appearance='mate' color="purple" intensity={500} className="rounded-4xl" icon={<TbPhotoPlus size={36}/>}/>
            <Button appearance='ghost' color="purple" intensity={700} className="rounded-lg" icon={<PiFolderUserBold size={32}/>} style={{ color: '#9D7BD6' }} onClick={() => changeState("myPhotos")}/>
        </Card>
    )
}