import {create} from 'zustand'
import axios from 'axios'
import useAuthStore from './auth.store';

interface User {
    email: string;
    password: string;
    loading: boolean;
    setEmail: (email: string) => void;
    setPassword: (password: string) => void;
    login(): Promise<void>;

}

const useLogInStore =  create<User>((set, get) => ({

    email: "",
    password: "",
    loading: false,
    setEmail: (email: string) => set({ email }),
    setPassword: (password: string) => set({ password }),

    login: async () => {
        const { email, password } = get();

        set({ loading: true });

        try {
            const response = await axios.post('/api/me/login', {
                email,
                password,
            });

            await useAuthStore.getState().loadUser();
            
            set({
                email: "",
                password: "",
            });
            console.log("Login exitoso:", response.data);

        } catch (error) {
            console.error("Error en el login:", error);
        } finally {
            set({ loading: false });
        }

    }
}))

export default useLogInStore;