import { create } from "zustand";
import axios from "axios";
import {
    readCachedAuthUser,
    writeCachedAuthUser,
} from "@/app/src/lib/pwa";

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
    logout: () => Promise<void>;
    loadUser: () => Promise<void>;
}

/** Validate the shape of a persisted user before trusting it. */
function isValidCachedUser(u: unknown): u is User {
    return (
        !!u &&
        typeof (u as User).id === "number" &&
        typeof (u as User).email === "string"
    );
}

// Optimistically hydrate the last-known user at store creation so an offline
// reload renders the gallery immediately. `loadUser()` still runs on mount to
// validate/refresh against the server (and clears this on 401/403). This is a UX
// hint only — see the security note in lib/pwa.ts.
const rawCached = readCachedAuthUser<User>();
const cachedUser = isValidCachedUser(rawCached) ? rawCached : null;

const useAuthStore = create<AuthStore>((set) => ({

    user: cachedUser,
    authenticated: cachedUser != null,
    loading: true,

    setUser: (user) => {
        writeCachedAuthUser(user);
        set({
            user,
            authenticated: true,
            loading: false
        });
    },

    logout: async () => {
        try {
            await axios.post("/api/me/logout");
        } finally {
            writeCachedAuthUser(null);
            set({
                user: null,
                authenticated: false,
                loading: false
            });
            // Limpiar el store del evento
            const { default: useEventStore } = await import('./event.store');
            useEventStore.setState({ event: null, loading: true });
            // Purge cached private event data + media so a logged-out session
            // cannot be shown stale cached content from the PWA caches.
            const { purgeServiceWorkerCaches } = await import("@/app/src/lib/pwa");
            purgeServiceWorkerCaches();
        }
    },

    loadUser: async () => {

        try {

            const response = await axios.get("/api/me");

            writeCachedAuthUser(response.data);
            set({
                user: response.data,
                authenticated: true,
                loading: false
            });

        } catch(error) {

            const status = axios.isAxiosError(error) ? error.response?.status : undefined;

            if (status === 401 || status === 403) {
                // Session is genuinely invalid (server reached, cookie rejected):
                // log out, clear the event store, and purge cached private data +
                // media so the invalidated session cannot see cached content.
                writeCachedAuthUser(null);
                set({ user: null, authenticated: false, loading: false });
                const { default: useEventStore } = await import('./event.store');
                useEventStore.setState({ event: null, isDemo: false, loading: false });
                const { purgeServiceWorkerCaches } = await import("@/app/src/lib/pwa");
                purgeServiceWorkerCaches();
            } else {
                // Network / offline error (no HTTP status): the session may still
                // be valid — do NOT force the login screen or purge caches, so the
                // PWA remains usable offline. Just stop the initial loading state.
                // If there was no prior user, `authenticated` stays false and the
                // login popup shows only once (as before) when truly logged out.
                set({ loading: false });
            }

        }

    }

}));


export default useAuthStore;