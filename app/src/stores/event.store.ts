import { create } from "zustand";
import axios from "axios";
import { Event } from "@/app/dto/event";


interface EventStore {
    event: Event | null;
    loading: boolean;
    fetchEvent: (event_slug: string) => Promise<void>;
    toggleLike: (mediaId: number) => Promise<void>;

}
const useEventStore = create<EventStore>((set, get) => ({

    event: null,
    loading: true,

    fetchEvent: async (event_slug: string) => {

        set({
            loading: true,
        });

        try {
            const response = await axios.get(`/api/event/${event_slug}`);

            set({
                event: response.data,
                loading: false,
            });

        } catch (error) {
            set({
                event: null,
                loading: false,
            });

            console.error("Error", error);
        }
    },

    toggleLike: async (mediaId: number) => {
        const event = get().event;

        if (!event) return;
        const updatedSections = event.sections.map((section) => {
            const updatedMedia = section.media.map((media) => {
                if (media.media_id === mediaId) {
                    return media
                }
                return {
                    ...media,
                    liked: !media.liked,
                    likes: media.liked ? media.likes - 1 : media.likes + 1
                }
            })
            return {
                ...section,
                media: updatedMedia
            }
        })

        const updatedEvent = {
            ...event,
            sections: updatedSections
        }

        set({
            event: updatedEvent
        })
    }

}));

export default useEventStore;