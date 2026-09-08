//Modify/delete data for a specific media file

import pool from '@/lib/db';
import { NextRequest } from 'next/server';
import { isDemoEvent, demoGuardResponse } from '@/lib/demo-guard';
import { isUnclassifiedSectionId } from '@/lib/sections';

export async function PATCH(
    request: NextRequest,
    { params }: { params: Promise<{ "event-slug": string; "media-id": string }> }
) {
    const { "event-slug": eventSlug, "media-id": mediaId } = await params;
    if (isDemoEvent(eventSlug)) return demoGuardResponse();

    const { section_id } = await request.json();

    if (!section_id) {
        return new Response("Section ID missing", {
            status: 400,
        });
    }

    // Moving into the hardcoded "Sin clasificar" fallback clears the section
    // (section_id = NULL) rather than pointing at a real section row.
    const targetSectionId: number | null = isUnclassifiedSectionId(section_id) ? null : section_id;

    const result = await pool.query(
        `
        UPDATE media
        SET section_id = $1
        WHERE media_id = $2
            AND event_id = (
              SELECT event_id
              FROM events
              WHERE event_slug = $3
            )
        RETURNING *
        `,
        [targetSectionId, mediaId, eventSlug]
    );

    if (result.rows.length === 0) {
        return new Response("Media not found", {
            status: 404,
        });
    }

    return new Response(JSON.stringify(result.rows[0]), {
        status: 200,
        headers: {
            "Content-Type": "application/json",
        },
    });
    
}