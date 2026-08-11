import { Section } from "./section";

export interface Event {
  event_id: number;
  event_name: string;
  event_slug: string;
  event_date: string;
  sections: Section[];
  fetchEvent: (event_slug: string) => Promise<void>;
  addEvent: () => void;
  removeEvent: () => void;
  updateEvent: () => void;
}