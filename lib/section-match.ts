// Server-side section matching for automatic media categorization.
//
// Categorization is based on the creation TIME-OF-DAY of the media (never the
// calendar date). Given an "HH:MM" creation time, we find the event section
// whose [start_date, finish_date] time-of-day window contains it. When there is
// no creation time, or no section matches, the caller leaves media.section_id
// NULL so the media falls back to the hardcoded "Sin clasificar" section
// (see lib/sections.ts).
//
// Shared by the confirm route (same-session + recovery) and the upload-token
// onUploadCompleted reconciliation path so both classify identically.

import type { Pool } from 'pg';

// Accepts "HH:MM" or "HH:MM:SS" (24h). Minutes/seconds 00-59, hours 00-23.
const TIME_OF_DAY_RE = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/;

/** True when `value` is a well-formed "HH:MM"/"HH:MM:SS" time-of-day string. */
export function isValidTimeOfDay(value: unknown): value is string {
    return typeof value === 'string' && TIME_OF_DAY_RE.test(value.trim());
}

/**
 * Resolve the section id for a media item from its creation time-of-day.
 *
 * Returns the matching section's id, or NULL when `creationTime` is null/blank/
 * malformed or no section's time window contains it. The comparison is on
 * time-of-day only (`::time`), matching the legacy route's semantics.
 */
export async function resolveSectionIdByTime(
    pool: Pool,
    eventId: number,
    creationTime: string | null | undefined,
): Promise<number | null> {
    if (!isValidTimeOfDay(creationTime)) {
        return null;
    }

    const result = await pool.query(
        `SELECT section_id FROM sections
         WHERE event_id = $1
         AND start_date::time <= $2::time AND finish_date::time >= $2::time
         LIMIT 1`,
        [eventId, creationTime.trim()],
    );

    return result.rows.length > 0 ? result.rows[0].section_id : null;
}
