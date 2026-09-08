// Hardcoded fallback section for media that could not be auto-categorized.
//
// Unclassified media is stored with `media.section_id = NULL` in the database
// rather than pointing at a per-event "Sin clasificar" row. The API response
// layer synthesizes this section on the fly so the client always has a stable
// place to show and move unclassified media into.
//
// The id is a sentinel string (never a real DB serial id) so it can be told
// apart from real sections everywhere: the client renders it, the move routes
// accept it to mean "clear the section" (set section_id = NULL), and the merge
// logic keys on it like any other section.

export const UNCLASSIFIED_SECTION_ID = "unclassified";
export const UNCLASSIFIED_SECTION_NAME = "Sin clasificar";

/** True when a move/section target refers to the hardcoded fallback section. */
export function isUnclassifiedSectionId(sectionId: unknown): boolean {
    return String(sectionId) === UNCLASSIFIED_SECTION_ID;
}
