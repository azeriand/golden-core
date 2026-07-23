import { create } from "zustand";

interface GlobalState {
    state: "home" | "myPhotos" | "favPhotos";
    changeState: (newState: GlobalState["state"]) => void;
}
const useGlobalStore = create<GlobalState>((set) => ({
    state: "home",

    changeState: (newState: GlobalState["state"]) => {
        set({ state: newState });
    }
}));

export default useGlobalStore;