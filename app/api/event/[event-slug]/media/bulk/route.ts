// Bulk operations on media: delete and move

import pool from '@/lib/db';
import { NextRequest } from 'next/server';
import jwt from 'jsonwebtoken';
import { del } from '@vercel/blob';

/**
 * DELETE /api/event/[event-slug]/media/bulk
 * Body: { mediaIds: number[] }
 * 
 * Deletes multiple media files. Users can only delete their own media unless they are admin.
 */
export async function DELETE(
    request: NextRequest,
    { params }: { params: Promise<{ "event-slug": string }> }
) {
    const { "event-slug": eventSlug } = await params;

    const token = request.cookies.get("auth_token")?.value;

    if (!token) {
        return new Response("Unauthorized", { status: 401 });
    }

    const jwtSecret = process.env.JWT_SECRET;

    if (!jwtSecret) {
        return new Response("JWT_SECRET is not configured", { status: 500 });
    }

    let decoded: any;

    try {
        decoded = jwt.verify(token, jwtSecret) as any;
    } catch {
        return new Response("Unauthorized", { status: 401 });
    }

    const userId = decoded.userId;
    const isAdmin = decoded.isAdmin;

    const body = await request.json();
    const mediaIds = body.mediaIds;

    if (!Array.isArray(mediaIds) || mediaIds.length === 0) {
        return new Response("No media IDs provided", { status: 400 });
    }

    // Get the event_id
    const eventResult = await pool.query(
        `SELECT event_id FROM events WHERE event_slug = $1`,
        [eventSlug]
    );

    if (eventResult.rows.length === 0) {
        return new Response("Event not found", { status: 404 });
    }

    const eventId = eventResult.rows[0].event_id;

    // Fetch media to delete, applying permission filter
    let mediaQuery: string;
    let mediaParams: any[];

    if (isAdmin) {
        // Admin can delete any media in the event
        mediaQuery = `
            SELECT media_id, content
            FROM media
            WHERE media_id = ANY($1::int[])
            AND event_id = $2
        `;
        mediaParams = [mediaIds, eventId];
    } else {
        // User can only delete their own media
        mediaQuery = `
            SELECT media_id, content
            FROM media
            WHERE media_id = ANY($1::int[])
            AND event_id = $2
            AND user_id = $3
        `;
        mediaParams = [mediaIds, eventId, userId];
    }

    const mediaResult = await pool.query(mediaQuery, mediaParams);

    if (mediaResult.rows.length === 0) {
        return new Response("No media found or permission denied", { status: 403 });
    }

    const foundIds = mediaResult.rows.map((row: any) => row.media_id);
    const blobUrls = mediaResult.rows.map((row: any) => row.content).filter(Boolean);

    // Delete from database
    await pool.query(
        `DELETE FROM media WHERE media_id = ANY($1::int[])`,
        [foundIds]
    );

    // Delete blobs from Vercel Blob storage (best effort)
    try {
        if (blobUrls.length > 0) {
            await del(blobUrls);
        }
    } catch (error) {
        console.error("Error deleting blobs:", error);
        // Don't fail the request if blob deletion fails
    }

    return new Response(JSON.stringify({ deleted: foundIds.length }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
    });
}

/**
 * PATCH /api/event/[event-slug]/media/bulk
 * Body: { mediaIds: number[], sectionId: string }
 * 
 * Moves multiple media files to a different section. Users can only move their own media unless they are admin.
 */
export async function PATCH(
    request: NextRequest,
    { params }: { params: Promise<{ "event-slug": string }> }
) {
    const { "event-slug": eventSlug } = await params;

    const token = request.cookies.get("auth_token")?.value;

    if (!token) {
        return new Response("Unauthorized", { status: 401 });
    }

    const jwtSecret = process.env.JWT_SECRET;

    if (!jwtSecret) {
        return new Response("JWT_SECRET is not configured", { status: 500 });
    }

    let decoded: any;

    try {
        decoded = jwt.verify(token, jwtSecret) as any;
    } catch {
        return new Response("Unauthorized", { status: 401 });
    }

    const userId = decoded.userId;
    const isAdmin = decoded.isAdmin;

    const body = await request.json();
    const { mediaIds, sectionId } = body;

    if (!Array.isArray(mediaIds) || mediaIds.length === 0) {
        return new Response("No media IDs provided", { status: 400 });
    }

    if (!sectionId) {
        return new Response("Section ID missing", { status: 400 });
    }

    // Get the event_id
    const eventResult = await pool.query(
        `SELECT event_id FROM events WHERE event_slug = $1`,
        [eventSlug]
    );

    if (eventResult.rows.length === 0) {
        return new Response("Event not found", { status: 404 });
    }

    const eventId = eventResult.rows[0].event_id;

    // Verify the target section belongs to this event
    const sectionResult = await pool.query(
        `SELECT section_id FROM sections WHERE section_id = $1 AND event_id = $2`,
        [sectionId, eventId]
    );

    if (sectionResult.rows.length === 0) {
        return new Response("Section not found in this event", { status: 404 });
    }

    // Update media, applying permission filter
    let updateQuery: string;
    let updateParams: any[];

    if (isAdmin) {
        // Admin can move any media in the event
        updateQuery = `
            UPDATE media
            SET section_id = $1
            WHERE media_id = ANY($2::int[])
            AND event_id = $3
            RETURNING media_id
        `;
        updateParams = [sectionId, mediaIds, eventId];
    } else {
        // User can only move their own media
        updateQuery = `
            UPDATE media
            SET section_id = $1
            WHERE media_id = ANY($2::int[])
            AND event_id = $3
            AND user_id = $4
            RETURNING media_id
        `;
        updateParams = [sectionId, mediaIds, eventId, userId];
    }

    const updateResult = await pool.query(updateQuery, updateParams);

    if (updateResult.rows.length === 0) {
        return new Response("No media found or permission denied", { status: 403 });
    }

    return new Response(JSON.stringify({ moved: updateResult.rows.length, sectionId }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
    });
}
