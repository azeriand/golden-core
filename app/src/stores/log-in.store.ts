import {create} from 'zustand'
import axios from 'axios'
import useAuthStore from './auth.store';

interface LogInState {
    email: string;
    password: string;
    loading: boolean;
    error: string | null;
    errorFields: string[];
    setEmail: (email: string) => void;
    setPassword: (password: string) => void;
    login(): Promise<void>;
}

const useLogInStore = create<LogInState>((set, get) => ({

    email: "",
    password: "",
    loading: false,
    error: null,
    errorFields: [],
    setEmail: (email: string) => set({ email, error: null, errorFields: [] }),
    setPassword: (password: string) => set({ password, error: null, errorFields: [] }),

    login: async () => {
        const { email, password } = get();

        if (!email || !password) {
            const fields: string[] = [];
            if (!email) fields.push('email');
            if (!password) fields.push('password');
            set({ error: "Todos los campos son obligatorios", errorFields: fields });
            return;
        }

        set({ loading: true, error: null, errorFields: [] });

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

        } catch (error: any) {
            const message = error?.response?.data?.message || "Credenciales incorrectas";
            set({ error: message, errorFields: ['email', 'password'] });
        } finally {
            set({ loading: false });
        }

    }
}))

export default useLogInStore;
