import { Section } from "./section";

export interface Event {
  event_id: number;
  event_name: string;
  event_slug: string;
  event_date: string;
  event_cover_img: string | null;
  sections: Section[];
  fetchEvent: (event_slug: string) => Promise<void>;
  addEvent: () => void;
  removeEvent: () => void;
  updateEvent: () => void;
}