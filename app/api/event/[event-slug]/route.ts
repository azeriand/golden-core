//Modify/get data/delete data for a specific event

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

export async function GET(_: any, { params }: { params: Promise<{ "event-slug": string }> }) {
  const { "event-slug": eventSlug } = await params;
 
  try {
    const result = await pool.query(
      `SELECT * FROM events
       LEFT JOIN sections ON events.event_id = sections.event_id
       LEFT JOIN media ON events.event_id = media.event_id
       WHERE event_slug = $1`,
       [eventSlug]
    );

    return new Response(JSON.stringify(result.rows), {
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