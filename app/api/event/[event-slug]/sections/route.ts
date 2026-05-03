//Create event sections
import pool from '@/lib/db';
import { SectionRequest } from '@/dto/section';
import { NextRequest } from 'next/server';

export async function POST(request: NextRequest, { params }: { params: Promise<{ "event-slug": string }> }) {
  const { sections }: { sections: SectionRequest[] } = await request.json();
  const { "event-slug": eventSlug } = await params;

  //iterar sections para meter for cada una en la base de datos
  if (!sections || sections.length === 0) {
    return new Response('Sections array missing', {
        status: 400,
        headers: { 'Content-Type': 'text/plain' }
    })
  }
  console.log('EVENT SLUG', eventSlug)
  const eventResult = await pool.query(`SELECT event_id FROM events WHERE event_slug = $1`, [eventSlug]);


  const promises = [];

  for (const { section_name, start_date, finish_date } of sections) {
    promises.push(pool.query(
    `INSERT INTO sections (section_name, start_date, finish_date, event_id)
    VALUES ($1, $2, $3, $4)
    RETURNING *`,
    [section_name, start_date, finish_date, eventResult.rows[0].event_id]
    ));
  }

  const results = await Promise.allSettled(promises);

  console.log('PROMISES', promises)

  return new Response(JSON.stringify(results), {
    status: 201,
    headers: { 'Content-Type': 'application/json' }
  });
}