//Modify/delete data for a specific media file

import pool from '@/lib/db';
import { NextRequest } from 'next/server';

export async function PATCH(
    request: NextRequest,
    { params }: { params: Promise<{ "event-slug": string; "media-id": string }> }
) {
    const { "event-slug": eventSlug, "media-id": mediaId } = await params;

    const { section_id } = await request.json();

    if (!section_id) {
        return new Response("Section ID missing", {
            status: 400,
        });
    }

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
        [section_id, mediaId, eventSlug]
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