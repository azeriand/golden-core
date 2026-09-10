//Modify/get data/delete data for a specific event

import jwt from "jsonwebtoken";
import pool from '@/lib/db';
import { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { isDemoEvent, demoGuardResponse, isDemoUser } from '@/lib/demo-guard';
import { UNCLASSIFIED_SECTION_ID, UNCLASSIFIED_SECTION_NAME } from '@/lib/sections';
import { Section } from '@/app/dto/section';
import { Media } from '@/app/dto/media';

export async function PUT(request: NextRequest, { params }: { params: Promise<{ "event-slug": string }> }) {
  const { "event-slug": eventSlug } = await params;
  if (isDemoEvent(eventSlug)) return demoGuardResponse();
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

  const jwtSecret = process.env.JWT_SECRET;

if (!jwtSecret) {
    return new Response("JWT_SECRET is not configured", {
        status: 500,
    });
}

  const decoded = jwt.verify(
    token,
    jwtSecret
  ) as any;

  const userId = decoded.userId;

  if (!userId) {
    return new Response("Unauthorized", {
      status: 401,
    });
  }

  // Demo user can only access the demo event
  if (isDemoUser(decoded.email) && !isDemoEvent(eventSlug)) {
    const cookieStore = await cookies();
    cookieStore.delete("auth_token");
    return Response.json(
      { error: "Demo user can only access the demo event" },
      { status: 403 }
    );
  }

  try {
    // Fetch the event with its real sections AND all its media. Media is joined
    // to sections by section_id, but media with a NULL section_id (unclassified)
    // must still be returned — so the join is driven from media, not sections,
    // and unclassified media is grouped under a hardcoded fallback section
    // (see lib/sections.ts) that is synthesized below rather than stored in the DB.
    const result = await pool.query(
    `SELECT
      events.event_id,
      events.event_name,
      events.event_slug,
      events.event_date,
      events.event_cover_img,
      sections.section_id,
      sections.section_name,
      sections.start_date,
      sections.finish_date,
      media.media_id,
      media.user_id,
      media.section_id AS media_section_id,
      media.content,
      media.date,
      media.type,
      media.blurhash,
      users.username,
      COALESCE(l.likes, 0) AS likes,
      EXISTS (
      SELECT 1
        FROM likes user_like
        WHERE user_like.media_id = media.media_id
          AND user_like.user_id = $2
      ) AS liked
      FROM events
      LEFT JOIN media ON events.event_id = media.event_id
      LEFT JOIN sections ON sections.section_id = media.section_id AND sections.event_id = media.event_id
      LEFT JOIN users ON media.user_id = users.user_id
      LEFT JOIN (
          SELECT media_id, COUNT(*) AS likes
          FROM likes
          GROUP BY media_id
      ) l ON media.media_id = l.media_id
      WHERE events.event_slug = $1
      ORDER BY sections.section_id NULLS LAST, media.date;`,
      [eventSlug, userId]
    );

    if (!result.rows || result.rows.length === 0) {
      return new Response('Event data not found', {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const rows = result.rows;

    // Also load the event's real sections independently so that empty sections
    // (no media yet) are still returned to the client. The media join above only
    // surfaces sections that have media.
    const sectionsResult = await pool.query(
      `SELECT s.section_id, s.section_name, s.start_date, s.finish_date
       FROM sections s
       WHERE s.event_id = $1
       ORDER BY s.section_id`,
      [rows[0].event_id]
    );

    const sections: Section[] = sectionsResult.rows.map((s: Record<string, unknown>) => ({
      section_id: s.section_id as number,
      section_name: s.section_name as string,
      start_date: s.start_date as string,
      finish_date: s.finish_date as string,
      media: [],
    }));
    const sectionById = new Map<string, Section>(sections.map((s) => [String(s.section_id), s]));

    // Hardcoded fallback section for unclassified media (section_id IS NULL).
    // Created lazily and appended last, only when there is unclassified media.
    let unclassified: Section | null = null;
    const ensureUnclassified = (): Section => {
      if (!unclassified) {
        unclassified = {
          section_id: UNCLASSIFIED_SECTION_ID,
          section_name: UNCLASSIFIED_SECTION_NAME,
          start_date: null,
          finish_date: null,
          media: [],
        };
      }
      return unclassified;
    };

    for (const row of rows) {
      const { media_id, media_section_id, user_id, content, likes, liked, date, type, blurhash, username } = row;
      if (media_id == null) continue; // event with no media (LEFT JOIN null row)

      const mediaItem: Media = { media_id, user_id, content, likes, liked, date, type, section_id: media_section_id, blurhash, username };
      const target =
        media_section_id == null
          ? ensureUnclassified()
          : sectionById.get(String(media_section_id));

      // A real section id that somehow isn't in the sections list (shouldn't
      // happen, but be defensive) falls back to the unclassified bucket.
      (target ?? ensureUnclassified()).media.push(mediaItem);
    }

    if (unclassified) {
      sections.push(unclassified);
    }

    const res = {
      event_id: rows[0].event_id,
      event_name: rows[0].event_name,
      event_slug: rows[0].event_slug,
      event_date: rows[0].event_date,
      event_cover_img: rows[0].event_cover_img ?? null,
      sections,
    };

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
