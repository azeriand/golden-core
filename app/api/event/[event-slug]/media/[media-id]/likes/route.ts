// Like or delete a like for a media file

import { NextRequest } from 'next/server';
import { cookies } from 'next/headers'
import jwt from "jsonwebtoken";
import pool from '@/lib/db';

export async function POST(
  request: NextRequest,
  { params }: {
    params: Promise<{
      "event-slug": string;
      "media-id": string;
    }>;
  }
) {
    const {
        "event-slug": eventSlug,
        "media-id": mediaId,
    } = await params;

    const token = request.cookies.get("auth_token")?.value;

    if (!token) {
        return new Response("Unauthorized", {
            status: 401,
        });
    }

    const decoded = jwt.verify(
        token,
        process.env.JWT_SECRET
    ) as any;

    const userId = decoded.userId;

    if (!userId) {
        return new Response("Unauthorized", {
            status: 401,
        });
    }

    const result = await pool.query(
        `SELECT media.media_id
        FROM media
        INNER JOIN events
        ON media.event_id = events.event_id
        WHERE media.media_id = $1
        AND events.event_slug = $2`,
        [mediaId, eventSlug]
    );

    if (result.rows.length === 0) {
        return new Response("Media not found", {
            status: 404,
        });
    }

    const likeResult = await pool.query(
        `
            SELECT 1
            FROM likes
            WHERE user_id = $1
            AND media_id = $2
        `,
        [userId, mediaId]
    );

    if (likeResult.rows.length > 0) {
        await pool.query(
            `
            DELETE FROM likes
            WHERE user_id = $1
            AND media_id = $2
            `,
            [userId, mediaId]
        );

    } else {
        await pool.query(
        `
            INSERT INTO likes (user_id, media_id)
            VALUES ($1, $2)
        `,
        [userId, mediaId]
        );

    }

    const countResult = await pool.query(
        `
            SELECT COUNT(*) AS likes
            FROM likes
            WHERE media_id = $1
        `,
        [mediaId]
    );

    const likes = Number(countResult.rows[0].likes);

    return new Response(
        JSON.stringify({
            liked: likeResult.rows.length === 0,
            likes,
        }),
        {
        status: 200,
        headers: {
            "Content-Type": "application/json",
        },
    });
}