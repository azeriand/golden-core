import { Card, Button } from "azeriand-library"
import useGlobalStore from "../src/stores/global.store";
import useUploadStore from "../src/stores/upload.store";
import { AiFillHome } from "react-icons/ai";
import { TbPhotoPlus } from "react-icons/tb";
import { PiFolderUserBold } from "react-icons/pi";
import { useRef, useState } from "react";
import { useParams } from "next/navigation";

export default function Navbar() {

    const params = useParams();
    const eventSlug = params["event-slug"] as string;
    const fileInputRef = useRef<HTMLInputElement>(null);

    const { state, changeState } = useGlobalStore();
    const { enqueueFiles } = useUploadStore();
    const [fileError, setFileError] = useState<string | null>(null);

    const updateState = (newState: "home" | "myPhotos" | "favPhotos" | "personalFolder") => {
        
        if (newState === "personalFolder" && state === 'favPhotos') return;
        if (newState === "personalFolder") {
            changeState('myPhotos');
        } else {
            changeState(newState);
        }
    }

    const defaultButtonProps = {appearance: 'ghost', intensity: 700, style: { color: '#9D7BD6' }};
    const selectedButtonProps = {intensity: 950};

    const homeButtonProps = state === "home" ? selectedButtonProps : defaultButtonProps;
    const personalFolderButtonProps = state === "myPhotos" || state === "favPhotos" ? selectedButtonProps : defaultButtonProps;

    return(
        <Card noPadding appearance='mate' color='white' className="flex justify-center gap-x-3 fixed bottom-4 left-4 right-4 border-t p-4 rounded-xl bg-[#FFFCF8]/95! backdrop-blur-md z-[100]" style={{ willChange: "transform" }}>
            <Button appearance='mate' icon={<AiFillHome size={32}/>} color="purple" className="rounded-full px-9!" onClick={() => updateState("home")} {...homeButtonProps}/>
            <Button appearance='mate' color="purple" intensity={500} className="rounded-full px-9!" icon={<TbPhotoPlus size={36}/>} onClick={() => fileInputRef.current?.click()}/>
            <input ref={fileInputRef} type="file" accept="image/*, video/*" multiple className="hidden" onChange={(e) => {
                const files = Array.from(e.target.files || []);
                if (files.length === 0) return;

                if (files.length > 20) {
                    setFileError("Puedes seleccionar hasta 20 archivos a la vez.");
                    e.target.value = "";
                    return;
                }

                setFileError(null);
                enqueueFiles(files, eventSlug);
                e.target.value = "";
            }}/>

            <Button appearance="mate" icon={<PiFolderUserBold size={32}/>} color="purple" className="rounded-full px-9!" onClick={() => updateState("personalFolder")} {...personalFolderButtonProps}/>
            {fileError && <p className="absolute -top-10 left-0 right-0 text-center text-red-500 text-sm bg-white/95 rounded-lg py-1 px-2">{fileError}</p>}
        </Card>
    )
}
