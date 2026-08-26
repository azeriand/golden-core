import pool from '@/lib/db';
import { NextRequest } from 'next/server';
import jwt from 'jsonwebtoken';

export async function GET( request: NextRequest, { params }: { params: Promise<{"event-slug": string; "media-id": string;}> }) {
    
    const {
        "event-slug": eventSlug,
        "media-id": mediaId
    } = await params;

    const token = request.cookies.get("auth_token")?.value;

    if (!token) {
        return new Response("Unauthorized", {
            status: 401,
        });
    }

    const jwtSecret = process.env.JWT_SECRET;

    if (!jwtSecret) {
        return new Response("JWT_SECRET is not configured", {
            status: 500,
        });
    }

    let decoded: any;

    try {
        decoded = jwt.verify(token, jwtSecret);
    } catch {
        return new Response("Unauthorized", {
            status: 401,
        });
    }

    const userId = decoded.userId;

    if (!userId) {
        return new Response("Unauthorized", {
            status: 401,
        });
    }

    const mediaResult = await pool.query(
        `
        SELECT
            media.media_id,
            media.content,
            media.type,
            media.event_id
        FROM media
        INNER JOIN events
            ON events.event_id = media.event_id
        WHERE media.media_id = $1
          AND events.event_slug = $2
        `,
        [mediaId, eventSlug]
    );

    if (mediaResult.rows.length === 0) {
        return new Response("Media not found", {
            status: 404,
        });
    }

    const media = mediaResult.rows[0];

    const blobResponse = await fetch(media.content);

    if (!blobResponse.ok) {
        return new Response("Error fetching media", {
            status: 502,
        });
    }

    const file = await blobResponse.arrayBuffer();

    const extension = media.type?.split("/")[1] || "bin";
    const filename = `media-${media.media_id}.${extension}`;

    return new Response(file, {
    status: 200,
    headers: {
        "Content-Type": media.type || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(file.byteLength),
    },
});
}