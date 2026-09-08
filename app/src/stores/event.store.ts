import { create } from "zustand";
import axios from "axios";
import { Event } from "@/app/dto/event";
import { Section } from "@/app/dto/section";
import { Media } from "@/app/dto/media";

interface EventStore {
    event: Event | null;
    loading: boolean;
    isDemo: boolean;
    fetchEvent: (event_slug: string) => Promise<void>;
    toggleLike: (mediaId: number) => Promise<void>;
    shareEvent: () => Promise<void>;
}

/** Shallow-equal two media rows on the fields the UI renders. */
function mediaEqual(a: Media, b: Media): boolean {
    return (
        a.media_id === b.media_id &&
        a.user_id === b.user_id &&
        a.content === b.content &&
        a.type === b.type &&
        a.likes === b.likes &&
        a.liked === b.liked &&
        a.date === b.date &&
        a.section_id === b.section_id &&
        a.blurhash === b.blurhash &&
        a.username === b.username
    );
}

/**
 * Merge a freshly fetched event into the previous one, PRESERVING object
 * identity wherever the data is unchanged, so React re-renders only the media
 * items that actually changed (rather than remounting the whole gallery when a
 * stale-while-revalidate response arrives with the same data). New/changed media
 * get fresh references; unchanged media keep their previous reference; removed
 * media drop out.
 */
function mergeEvent(prev: Event | null, next: Event): Event {
    if (!prev) return next;

    const prevMediaById = new Map<number, Media>();
    for (const s of prev.sections) {
        for (const m of s.media) prevMediaById.set(m.media_id, m);
    }

    let anyChange =
        prev.event_id !== next.event_id ||
        prev.event_name !== next.event_name ||
        prev.event_slug !== next.event_slug ||
        prev.event_date !== next.event_date ||
        prev.sections.length !== next.sections.length;

    const sections: Section[] = next.sections.map((nextSection) => {
        const prevSection = prev.sections.find(
            (s) => String(s.section_id) === String(nextSection.section_id)
        );

        const media: Media[] = nextSection.media.map((nm) => {
            const existing = prevMediaById.get(nm.media_id);
            if (existing && mediaEqual(existing, nm)) return existing; // keep ref
            anyChange = true;
            return nm;
        });

        if (
            prevSection &&
            prevSection.section_name === nextSection.section_name &&
            prevSection.start_date === nextSection.start_date &&
            prevSection.finish_date === nextSection.finish_date &&
            prevSection.media.length === media.length &&
            media.every((m, i) => m === prevSection.media[i])
        ) {
            // Section unchanged (same fields AND same media refs) — keep its ref.
            return prevSection;
        }
        anyChange = true;
        return { ...nextSection, media };
    });

    // Nothing changed at all — return the SAME event object so no re-render.
    if (!anyChange) return prev;

    return { ...next, sections };
}

const useEventStore = create<EventStore>((set, get) => ({

    event: null,
    loading: true,
    isDemo: false,

    fetchEvent: async (event_slug: string) => {

        const current = get().event;
        // Only blank the gallery to the loader when we are switching to a
        // DIFFERENT event (or have none). If we already have THIS event (e.g. a
        // stale-while-revalidate response served from the SW cache, or a
        // background refresh), keep it on screen and merge the response in place
        // so the gallery is not remounted/blanked.
        const sameSlug = current?.event_slug === event_slug;
        if (!sameSlug) {
            set({ event: null, loading: true });
        }

        try {
            const response = await axios.get(`/api/event/${event_slug}`);

            set((state) => ({
                event: mergeEvent(sameSlug ? state.event : null, response.data),
                isDemo: response.data.event_slug === "demo",
                loading: false,
            }));

        } catch (error) {
            // If unauthorized (401) or forbidden (403 — e.g. demo session
            // invalidated), the session is no longer valid: clear auth + event
            // state and PURGE the PWA caches so the invalid session can never be
            // shown cached private event data / media.
            const status = axios.isAxiosError(error) ? error.response?.status : undefined;
            if (status === 401 || status === 403) {
                set({ event: null, isDemo: false, loading: false });
                const { purgeServiceWorkerCaches, clearCachedAuthUser } = await import("@/app/src/lib/pwa");
                purgeServiceWorkerCaches();
                clearCachedAuthUser();
                const { default: useAuthStore } = await import('./auth.store');
                useAuthStore.setState({ user: null, authenticated: false, loading: false });
            } else {
                // Network/offline error: KEEP any already-loaded (cached) event on
                // screen so the app stays usable offline; just stop loading.
                set({ loading: false });
                // Only surface an error when we have NOTHING to show (a genuine
                // "can't load the event" — e.g. offline with no cached copy). A
                // background revalidate that fails while cached content is on
                // screen stays silent so we don't nag on every offline refresh.
                if (!get().event) {
                    const { default: useErrorStore } = await import("./error.store");
                    useErrorStore.getState().showError("No se pudo cargar el evento.");
                }
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
            // Revert to previous state on failure and surface a user-facing
            // error (offline-aware). Likes are a user-initiated action, so the
            // failure must not be silent.
            set({ event: previousEvent });
            const { default: useErrorStore } = await import("./error.store");
            useErrorStore.getState().showError("No se pudo actualizar el me gusta.");
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
