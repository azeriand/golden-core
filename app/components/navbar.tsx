import { Card, Button } from "azeriand-library"
import useGlobalStore from "../src/stores/global.store";
import { AiFillHome } from "react-icons/ai";
import { TbPhotoPlus } from "react-icons/tb";
import { PiFolderUserBold } from "react-icons/pi";
import { useRef } from "react";
import { useParams } from "next/navigation";
import useEventStore from "../src/stores/event.store";

export default function Navbar() {

    const params = useParams();
    const eventSlug = params["event-slug"] as string;
    const fileInputRef = useRef<HTMLInputElement>(null);

    const { state, changeState } = useGlobalStore();
    const { fetchEvent } = useEventStore();

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
        <Card noPadding appearance='mate' color='white' className="flex justify-center gap-x-3 fixed bottom-4 left-4 right-4 border-t p-4 rounded-xl bg-white/95! backdrop-blur-md w-full" style={{ willChange: "transform" }}>
            <Button appearance='mate' icon={<AiFillHome size={32}/>} color="purple" className="rounded-full px-9!" onClick={() => updateState("home")} {...homeButtonProps}/>
            <Button appearance='mate' color="purple" intensity={500} className="rounded-full px-9!" icon={<TbPhotoPlus size={36}/>} onClick={() => fileInputRef.current?.click()}/>
            <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const formData = new FormData();

                formData.append("file", file);
                formData.append("date", new Date().toISOString());

                const response = await fetch(
                    `/api/event/${eventSlug}/media`,
                    {
                        method: "POST",
                        body: formData,
                    }
                );

                const data = await response.json();
                console.log("UPLOAD RESULT:", data);
                
                await fetchEvent(eventSlug);

            }}/>

            <Button appearance="mate" icon={<PiFolderUserBold size={32}/>} color="purple" className="rounded-full px-9!" onClick={() => updateState("personalFolder")} {...personalFolderButtonProps}/>
        </Card>
    )
}