import { create } from "zustand";
import axios from "axios";
import { Event } from "@/app/dto/event";


interface EventStore {
  event: Event | null;
  loading: boolean;
  fetchEvent: (event_slug: string) => Promise<void>;
}
const useEventStore = create<EventStore>((set) => ({

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

}));

export default useEventStore;