//Upload media files for a specific event
import pool from '@/lib/db';
import { NextRequest } from 'next/server';
import jwt from 'jsonwebtoken'
import { cookies } from 'next/headers'
import { put } from "@vercel/blob";
import exifr from 'exifr';

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
  
    const arrayBuffer = await file.arrayBuffer();
    const exif = await exifr.parse(arrayBuffer);
    const dateTimeOriginal = exif?.DateTimeOriginal;
    const photoOffset = exif?.OffsetTimeOriginal;
    
    let photoTime = null;

    if (dateTimeOriginal && photoOffset) {
        const [hours, minutes] = photoOffset
            .split(":")
            .map(Number);

        const offsetMinutes = hours * 60 + minutes;

        const localDate = new Date(
            dateTimeOriginal.getTime() + offsetMinutes * 60 * 1000
        );

        photoTime = localDate.toISOString().slice(11, 16);
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

        const jwtSecret = process.env.JWT_SECRET;

        if (!jwtSecret) {
            return new Response("JWT_SECRET is not configured", {
                status: 500,
            });
        }
        
        decoded = jwt.verify(
            token,
            jwtSecret
        ) as any

    } catch {
        return new Response(JSON.stringify({ user: null }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
        })
    }
    
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

    let sectionId: number;

    try {
        if (photoTime !== null) {
            // Tenemos una hora: intentamos encontrar la sección correspondiente
            const sectionResult = await pool.query(
                `
                SELECT section_id
                FROM sections
                WHERE event_id = $1
                AND section_name <> 'Sin clasificar'
                AND start_date::time <= $2::time
                AND finish_date::time >= $2::time
                LIMIT 1
                `,
                [eventId, photoTime]
            );

            if (sectionResult.rows.length === 0) {
                // Tenemos hora, pero ninguna sección coincide
                const fallbackResult = await pool.query(
                    `
                    SELECT section_id
                    FROM sections
                    WHERE event_id = $1
                    AND section_name = 'Sin clasificar'
                    LIMIT 1
                    `,
                    [eventId]
                );

                if (fallbackResult.rows.length === 0) {
                    return new Response("Sin clasificar section not found", {
                        status: 500,
                    });
                }

                sectionId = fallbackResult.rows[0].section_id;
            } else {
                sectionId = sectionResult.rows[0].section_id;
            }

        } else {
            // No tenemos hora: usamos "Sin clasificar"
            const fallbackResult = await pool.query(
                `
                SELECT section_id
                FROM sections
                WHERE event_id = $1
                AND section_name = 'Sin clasificar'
                LIMIT 1
                `,
                [eventId]
            );

            if (fallbackResult.rows.length === 0) {
                return new Response("Sin clasificar section not found", {
                    status: 500,
                });
            }

            sectionId = fallbackResult.rows[0].section_id;
        }

    } catch (error) {
        console.error("Error finding section:", error);

        return new Response("Error finding section", {
            status: 500,
        });
    }

    const blob = await put(file.name, file, {
        access: "public",
    });

    const content = blob.url;

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