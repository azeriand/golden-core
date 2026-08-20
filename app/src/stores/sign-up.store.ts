import {create} from 'zustand'
import axios from 'axios'
import useAuthStore from './auth.store';

interface SignUpState {
    email: string;
    password: string;
    username: string;
    confirmPassword: string;
    loading: boolean;
    error: string | null;
    errorFields: string[];
    setEmail: (email: string) => void;
    setPassword: (password: string) => void;
    setUsername: (username: string) => void;
    setConfirmPassword: (confirmPassword: string) => void;
    register: () => Promise<void>;
}

const useSignUpStore = create<SignUpState>((set, get) => ({

    email: "",
    password: "",
    username: "",
    confirmPassword: "",
    loading: false,
    error: null,
    errorFields: [],
    setEmail: (email: string) => set({ email, error: null, errorFields: [] }),
    setPassword: (password: string) => set({ password, error: null, errorFields: [] }),
    setUsername: (username: string) => set({ username, error: null, errorFields: [] }),
    setConfirmPassword: (confirmPassword: string) => set({ confirmPassword, error: null, errorFields: [] }),

    register: async () => {
        const { email, username, password, confirmPassword } = get();

        if (!email || !username || !password || !confirmPassword) {
            const fields: string[] = [];
            if (!email) fields.push('email');
            if (!username) fields.push('username');
            if (!password) fields.push('password');
            if (!confirmPassword) fields.push('confirmPassword');
            set({ error: "Todos los campos son obligatorios", errorFields: fields });
            return;
        }

        if (password !== confirmPassword) {
            set({ error: "Las contraseñas no coinciden", errorFields: ['password', 'confirmPassword'] });
            return;
        }

        const defaultEventId = 1;

        set({ loading: true, error: null, errorFields: [] });

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

        } catch (error: any) {
            const message = error?.response?.data?.message || "Error en el registro";
            set({ error: message, errorFields: [] });
        } finally {
            set({ loading: false });
        }

    }
}))

export default useSignUpStore;
