import { Media } from "./media";

export type SectionRequest = {
    section_name: string;
    start_date: string;
    finish_date: string;
}

export type Section = SectionRequest & {
    section_id: string;
    event_id: string;
    media: Media[];
}