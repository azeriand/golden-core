import { create } from "zustand";
import axios from "axios";

interface User {
    id: number;
    username: string;
    email: string;
    isAdmin: boolean;
    eventId: number;
}

interface AuthStore {
    user: User | null;
    authenticated: boolean;
    loading: boolean;

    setUser: (user: User) => void;
    logout: () => void;
    loadUser: () => Promise<void>;
}

const useAuthStore = create<AuthStore>((set) => ({

    user: null,
    authenticated: false,
    loading: true,

    setUser: (user) => set({
        user,
        authenticated: true,
        loading: false
    }),

    logout: () => set({
        user: null,
        authenticated: false,
        loading: false
    }),

    loadUser: async () => {

        try {

            const response = await axios.get("/api/me");

            set({
                user: response.data,
                authenticated: true,
                loading: false
            });

        } catch(error) {

            set({
                user: null,
                authenticated: false,
                loading: false
            });

        }

    }

}));


export default useAuthStore;