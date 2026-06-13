import { create } from "zustand";
import axios from "axios";
import { Section } from "@/app/dto/section";

interface EventState {
  event_id: number;
  event_name: string;
  event_slug: string;
  event_date: string;
  sections: any[];
  fetchEvent: (event_slug: string) => Promise<void>;
  addEvent: () => void;
  removeEvent: () => void;
  updateEvent: () => void;
}

const useEventStore = create<EventState>((set) => ({

    event_id: 0,
    event_name: "",
    event_slug: "",
    event_date: "",
    sections: [],

  fetchEvent: async (event_slug: string) => {
    try {
      const response = await axios.get(`/api/event/${event_slug}`);

      console.log(response.data);
      set({
        event_id: response.data.event_id,
        event_name: response.data.event_name,
        event_date: response.data.event_date,
        event_slug: response.data.event_slug,
        sections: response.data.sections.map((section: Section) => section),
      });
    } catch (error) {
      set({
        event_id: 0,
        event_name: "Boda No Encontrada",
        event_slug: "",
        event_date: "",
        sections: [],
      });
    console.error("Error", error);
  }
  },
  addEvent: () => {},
  removeEvent: () => {},
  updateEvent: () => {},

}));

export default useEventStore;