//Upload media files for a specific event
import pool from '@/lib/db';
import { NextRequest } from 'next/server';
import jwt from 'jsonwebtoken'
import { cookies } from 'next/headers'
import { put } from "@vercel/blob";

export async function POST(request: NextRequest, { params }: { params: Promise<{ "event-slug": string }> }) {
    const { "event-slug": eventSlug } = await params;
    const cookieStore = await cookies()
    const token = cookieStore.get('auth_token')?.value

    const formData = await request.formData();
    const file = formData.get("file");
    const date = formData.get("date") as string;

    if (!(file instanceof File)) {
        return new Response("File missing", {
            status: 400,
        });
    }
  
    if (!date) {
        return new Response('Date missing', {
            status: 400,
            headers: { 'Content-Type': 'text/plain' }
        })
    }

    if (!token) {
        return new Response(JSON.stringify({ user: null }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
        })
    }

    let decoded: any
    try {
        decoded = jwt.verify(
            token,
            process.env.JWT_SECRET
        ) as any

    } catch {
        return new Response(JSON.stringify({ user: null }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
        })
    }
    console.log('DECODED', decoded)
    const userId = decoded.userId

    const eventResult = await pool.query(
        `
        SELECT event_id
        FROM events
        WHERE event_slug = $1
        `,
        [eventSlug]
    );

    if (eventResult.rows.length === 0) {
        return new Response("Event not found", {
            status: 404,
        });
    }

    const eventId = eventResult.rows[0].event_id;

    const blob = await put(file.name, file, {
        access: "public",
    });

    const content = blob.url;

    const result = await pool.query(
        `INSERT INTO media (content, date, user_id, section_id, event_id)
        VALUES ($1, $2, $3, NULL, $4)
        RETURNING *`,
        [content, date, userId, eventId]
    );

    return new Response(JSON.stringify(result.rows[0]), {
        status: 201,
        headers: { 'Content-Type': 'application/json' }
    })
}