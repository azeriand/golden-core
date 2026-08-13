//Modify/get data/delete data for a specific event

import jwt from "jsonwebtoken";
import pool from '@/lib/db';
import { NextRequest } from 'next/server';

export async function PUT(request: NextRequest, { params }: { params: Promise<{ "event-slug": string }> }) {
  const { "event-slug": eventSlug } = await params;
  const { name, date } = await request.json();

  if (!name) {
    return new Response('Name missing', {
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
 
  try {
    const result = await pool.query(
      `UPDATE events
       SET event_name = $1, event_slug = $2
       WHERE event_slug = $3`,
      [name, name.toLowerCase().replace(/\s+/g, '-')+'-'+date, eventSlug]
    );
    return new Response('OK', {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response('Event not found', {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ "event-slug": string }> }) {
  const { "event-slug": eventSlug } = await params;
 
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

  try {
    const result = await pool.query(
    `SELECT
      events.event_id,
      events.event_name,
      events.event_slug,
      events.event_date,
      sections.section_id,
      sections.section_name,
      sections.start_date,
      sections.finish_date,
      media.media_id,
      media.user_id,
      media.content,
      media.date,
      COALESCE(l.likes, 0) AS likes,
      EXISTS (
      SELECT 1
        FROM likes user_like
        WHERE user_like.media_id = media.media_id
          AND user_like.user_id = $2
      ) AS liked
      FROM events
      LEFT JOIN sections ON events.event_id = sections.event_id
      LEFT JOIN media ON sections.section_id = media.section_id
      LEFT JOIN (
          SELECT media_id, COUNT(*) AS likes
          FROM likes
          GROUP BY media_id
      ) l ON media.media_id = l.media_id
      WHERE events.event_slug = $1
      ORDER BY sections.section_id, media.date;`,
      [eventSlug, userId]
    );

    if (!result.rows || result.rows.length === 0) {
      return new Response('Event data not found', {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const rows = result.rows;
    const res = {
      event_id: rows[0].event_id,
      event_name: rows[0].event_name,
      event_slug: rows[0].event_slug,
      event_date: rows[0].event_date,
      sections: rows.reduce((acc: any[], row: any) => {
        const { section_id, section_name, start_date, finish_date, media_id, user_id, content, likes, liked, date } = row;
        // If there's no section for this row (outer join resulted in null), skip
        if (section_id == null) return acc;

        let section = acc.find(s => s.section_id === section_id);
        if (!section) {
          section = {
            section_id,
            section_name,
            start_date,
            finish_date,
            media: []
          };
          acc.push(section);
        }

        // Only add media when media exists (media_id may be null from LEFT JOIN)
        if (media_id != null) {
          section.media.push({ media_id, user_id, content, likes, liked, date });
        }

        return acc;
      }, [])
    }

    return new Response(JSON.stringify(res), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response('Event data not found', {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }

}