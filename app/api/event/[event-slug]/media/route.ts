//Upload media files for a specific event
import pool from '@/lib/db';
import { NextRequest } from 'next/server';
import jwt from 'jsonwebtoken'
import { cookies } from 'next/headers'

export async function POST(request: NextRequest, { params }: { params: Promise<{ "event-slug": string }> }) {
    const { "event-slug": eventSlug } = await params;
    const { content, date, sectionId, eventId} = await request.json();

    const cookieStore = await cookies()
    const token = cookieStore.get('auth_token')?.value

    if (!content) {
        return new Response('Media content missing', {
            status: 400,
            headers: { 'Content-Type': 'text/plain' }
        })
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
    const result = await pool.query(
        `INSERT INTO media (content, date, user_id, section_id, event_id)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *`,
        [content, date, userId, sectionId, eventId]
    );

    return new Response(JSON.stringify(result.rows[0]), {
        status: 201,
        headers: { 'Content-Type': 'application/json' }
    })
}