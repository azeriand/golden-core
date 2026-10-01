//Get/modify/delete data for a specific media file

import pool from '@/lib/db';
import { NextRequest } from 'next/server';
import { verifyRequest } from '@/lib/auth';
import { isDemoEvent, demoGuardResponse } from '@/lib/demo-guard';
import { isUnclassifiedSectionId } from '@/lib/sections';

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ "event-slug": string; "media-id": string }> }
) {
    const { "event-slug": eventSlug, "media-id": mediaId } = await params;

    const auth = verifyRequest(request);
    if (!auth.ok) {
        return auth.response;
    }
    const { userId, isAdmin } = auth.user;

    const result = await pool.query(
        `SELECT
            m.media_id,
            m.user_id,
            m.content,
            m.type,
            m.date,
            m.section_id,
            m.blurhash,
            m.width,
            m.height,
            m.poster_url,
            m.original_url,
            u.username,
            COALESCE(l.likes, 0) AS likes,
            EXISTS (
                SELECT 1
                FROM likes ul
                WHERE ul.media_id = m.media_id
                  AND ul.user_id = $3
            ) AS liked
        FROM media m
        JOIN users u ON m.user_id = u.user_id
        LEFT JOIN (
            SELECT media_id, COUNT(*) AS likes
            FROM likes
            GROUP BY media_id
        ) l ON m.media_id = l.media_id
        JOIN events e ON m.event_id = e.event_id
        WHERE m.media_id = $1
          AND e.event_slug = $2
          AND (m.is_hidden = false OR $4 = true)`,
        [mediaId, eventSlug, userId, isAdmin]
    );

    if (result.rows.length === 0) {
        return new Response("Media not found", { status: 404 });
    }

    const row = result.rows[0];

    // Public DTO — never expose is_hidden, hidden_at, or hidden_by (Req 3.5)
    const media = {
        media_id: row.media_id,
        user_id: row.user_id,
        content: row.content,
        type: row.type,
        likes: Number(row.likes),
        liked: Boolean(row.liked),
        date: row.date,
        section_id: row.section_id,
        blurhash: row.blurhash,
        width: row.width ?? null,
        height: row.height ?? null,
        poster_url: row.poster_url ?? null,
        original_url: row.original_url ?? null,
        username: row.username,
    };

    return new Response(JSON.stringify(media), {
        status: 200,
        headers: { "Content-Type": "application/json" },
    });
}

export async function PATCH(
    request: NextRequest,
    { params }: { params: Promise<{ "event-slug": string; "media-id": string }> }
) {
    const { "event-slug": eventSlug, "media-id": mediaId } = await params;
    if (isDemoEvent(eventSlug)) return demoGuardResponse();

    // Require a valid session before mutating any media row. Returns 401 on a
    // missing/invalid/expired token and 500 if JWT_SECRET is unset (lib/auth.ts).
    const auth = verifyRequest(request);
    if (!auth.ok) {
        return auth.response;
    }
    const { userId, isAdmin } = auth.user;

    const { section_id } = await request.json();

    if (!section_id) {
        return new Response("Section ID missing", {
            status: 400,
        });
    }

    // Moving into the hardcoded "Sin clasificar" fallback clears the section
    // (section_id = NULL) rather than pointing at a real section row.
    const targetSectionId: number | null = isUnclassifiedSectionId(section_id) ? null : section_id;

    // Authorization: a regular user may only move their OWN media; admins may
    // move any media in the event. The event-scoping subquery is kept so a
    // media row is only touched when it truly belongs to this event's slug.
    // The 404 below then covers both "does not exist / wrong event" and
    // "belongs to another user" (no ownership leak).
    // 
    // Hidden media is only accessible to admins - non-admins get 404.
    const result = isAdmin
        ? await pool.query(
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
        )
        : await pool.query(
            `
            UPDATE media
            SET section_id = $1
            WHERE media_id = $2
                AND user_id = $4
                AND is_hidden = false
                AND event_id = (
                  SELECT event_id
                  FROM events
                  WHERE event_slug = $3
                )
            RETURNING *
            `,
            [targetSectionId, mediaId, eventSlug, userId]
        );

    if (result.rows.length === 0) {
        return new Response("Media not found", {
            status: 404,
        });
    }

    // Return only the public Media DTO fields — never expose visibility
    // metadata (is_hidden, hidden_at, hidden_by) in public responses (Req 3.5).
    const row = result.rows[0];
    const publicMedia = {
        media_id: row.media_id,
        user_id: row.user_id,
        content: row.content,
        type: row.type,
        likes: 0,
        liked: false,
        date: row.date,
        section_id: row.section_id,
        blurhash: row.blurhash,
        width: row.width ?? null,
        height: row.height ?? null,
        poster_url: row.poster_url ?? null,
        original_url: row.original_url ?? null,
        username: null,
    };

    return new Response(JSON.stringify(publicMedia), {
        status: 200,
        headers: {
            "Content-Type": "application/json",
        },
    });
    
}