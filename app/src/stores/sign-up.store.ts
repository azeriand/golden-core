import {create} from 'zustand'
import axios from 'axios'
import useAuthStore from './auth.store';

interface User {
    email: string;
    password: string;
    username: string;
    confirmPassword: string;
    loading: boolean;
    setEmail: (email: string) => void;
    setPassword: (password: string) => void;
    setUsername: (username: string) => void;
    setConfirmPassword: (confirmPassword: string) => void;
    register: () => Promise<void>;
}

const useSignUpStore =  create<User>((set, get) => ({

    email: "",
    password: "",
    username: "",
    confirmPassword: "",
    loading: false,
    setEmail: (email: string) => set({ email }),
    setPassword: (password: string) => set({ password }),
    setUsername: (username: string) => set({ username }),
    setConfirmPassword: (confirmPassword: string) => set({ confirmPassword }),

    register: async () => {
        const { email, username, password, confirmPassword } = get();

        if (password !== confirmPassword) {
            alert("Passwords do not match");
            return;
        }

        const defaultEventId = 1;

        set({ loading: true });

        try {
            const response = await axios.post('/api/me', {
                email,
                username,
                password,
                eventId: defaultEventId
            });

            await useAuthStore.getState().loadUser();
            
            set({
                email: "",
                username: "",
                password: "",
                confirmPassword: "",
            });

        } catch (error) {
            console.error("Error en el registro:", error);
        } finally {
            set({ loading: false });
        }

    }
}))

export default useSignUpStore;