import { Card, Button } from "azeriand-library"
import useGlobalStore from "../src/stores/global.store";
import { AiFillHome } from "react-icons/ai";
import { TbPhotoPlus } from "react-icons/tb";
import { PiFolderUserBold } from "react-icons/pi";
import { useState } from "react";


export default function Navbar() {

    const { state, changeState } = useGlobalStore();

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
        <Card noPadding color='white' intensity={200} className="flex justify-center gap-x-3 fixed bottom-4 left-4 right-4 border-t p-4 rounded-xl">
            <Button icon={<AiFillHome size={32}/>} color="purple" className="rounded-full px-9!" onClick={() => updateState("home")} {...homeButtonProps}/>
            <Button appearance='mate' color="purple" intensity={500} className="rounded-full px-9!" icon={<TbPhotoPlus size={36}/>}/>
            <Button icon={<PiFolderUserBold size={32}/>} color="purple" className="rounded-full px-9!" onClick={() => updateState("personalFolder")} {...personalFolderButtonProps}/>
        </Card>
    )
}