import { Media } from "./media";

export type SectionRequest = {
    section_name: string;
    start_date: string;
    finish_date: string;
}

export type Section = {
    section_name: string;
    // Real sections use their numeric DB id (serialized as a number). The
    // hardcoded "Sin clasificar" fallback uses the string sentinel from
    // lib/sections.ts (UNCLASSIFIED_SECTION_ID) and has null dates.
    section_id: number | string;
    event_id?: string;
    start_date: string | null;
    finish_date: string | null;
    media: Media[];
}
