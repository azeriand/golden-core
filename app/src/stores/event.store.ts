import { create } from "zustand";
import axios from "axios";
import { Event } from "@/app/dto/event";


interface EventStore {
    event: Event | null;
    loading: boolean;
    isDemo: boolean;
    fetchEvent: (event_slug: string) => Promise<void>;
    toggleLike: (mediaId: number) => Promise<void>;
    shareEvent: () => Promise<void>;
}

const useEventStore = create<EventStore>((set, get) => ({

    event: null,
    loading: true,
    isDemo: false,

    fetchEvent: async (event_slug: string) => {

        // Clear any stale event from a previous slug and mark loading.
        set({
            event: null,
            loading: true,
        });

        try {
            const response = await axios.get(`/api/event/${event_slug}`);

            set({
                event: response.data,
                isDemo: response.data.event_slug === "demo",
                loading: false,
            });

        } catch (error: any) {
            set({
                event: null,
                isDemo: false,
                loading: false,
            });

            // If unauthorized (401) or forbidden (403 — e.g. demo session invalidated),
            // clear auth state so the client reflects that the cookie is gone.
            const status = error?.response?.status;
            if (status === 401 || status === 403) {
                const { default: useAuthStore } = await import('./auth.store');
                useAuthStore.setState({ user: null, authenticated: false, loading: false });
            }

            console.error("Error", error);
        }
    },

    toggleLike: async (mediaId: number) => {
        const event = get().event;

        if (!event) return;

        // Optimistically update the UI immediately
        const previousEvent = event;

        const optimisticSections = event.sections.map((section) => ({
            ...section,
            media: section.media.map((media) => {
                if (media.media_id === mediaId) {
                    return {
                        ...media,
                        liked: !media.liked,
                        likes: media.liked ? Number(media.likes) - 1 : Number(media.likes) + 1,
                    };
                }
                return media;
            }),
        }));

        set({
            event: {
                ...event,
                sections: optimisticSections,
            },
        });

        try {
            const response = await axios.post(
                `/api/event/${event.event_slug}/media/${mediaId}/likes`
            );

            const { liked, likes } = response.data;

            // Reconcile with server response
            const currentEvent = get().event;
            if (!currentEvent) return;

            const reconciledSections = currentEvent.sections.map((section) => ({
                ...section,
                media: section.media.map((media) => {
                    if (media.media_id === mediaId) {
                        return {
                            ...media,
                            liked,
                            likes,
                        };
                    }
                    return media;
                }),
            }));

            set({
                event: {
                    ...currentEvent,
                    sections: reconciledSections,
                },
            });

        } catch (error) {
            // Revert to previous state on failure
            set({ event: previousEvent });
            console.error("Error toggling like", error);
        }
    },

    shareEvent: async () => {
        const { event } = get();

        if (!event) {
            return;
        }

        const url = window.location.href;

        try {
            if (navigator.share) {
                await navigator.share({
                    title: event.event_name,
                    text: `Mira las fotos de ${event.event_name}`,
                    url,
                });

                return;
            }

            await navigator.clipboard.writeText(url);

            alert("Enlace copiado");
        } catch (error) {
            if (
                error instanceof DOMException &&
                error.name === "AbortError"
            ) {
                return;
            }

            console.error("Error al compartir el evento:", error);
        }
    },

}));

export default useEventStore;
