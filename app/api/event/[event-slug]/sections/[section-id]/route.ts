//Modify/delete data for a specific event section

import pool from '@/lib/db';
import { NextRequest } from 'next/server';
import { isDemoEvent, demoGuardResponse } from '@/lib/demo-guard';

export async function PUT(request: NextRequest, { params }: { params: Promise<{ "event-slug": string } & { "section-id": string }> }) {
  const { "event-slug": eventSlug, "section-id": sectionId } = await params;
  if (isDemoEvent(eventSlug)) return demoGuardResponse();
  const { name, startDate, finishDate, sectionOrder } = await request.json();

  if (!name) {
    return new Response('Name missing', {
        status: 400,
        headers: { 'Content-Type': 'text/plain' }
    })
  }
  
  if (!startDate) {
    return new Response('Start date missing', {
        status: 400,
        headers: { 'Content-Type': 'text/plain' }
    })
  }
 
  try {
    const result = await pool.query(
      `UPDATE sections s
       SET section_name = $1, start_date = $2, finish_date = $3, section_order = $4
       FROM events e
       WHERE e.event_id = s.event_id and e.event_slug = $5 and s.section_id = $6`,
      [name, startDate, finishDate, sectionOrder, eventSlug, sectionId]
    );
    return new Response('OK', {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {

    const message = error instanceof Error ? error.message : "Unknown error";

    return new Response(message, {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
}

export async function DELETE(_: any, { params }: { params: Promise<{ "event-slug": string } & { "section-id": string }> }) {
  const { "event-slug": eventSlug, "section-id": sectionId } = await params;
  if (isDemoEvent(eventSlug)) return demoGuardResponse();

  try {
    const result = await pool.query(
      `DELETE FROM sections s
       USING events e
       WHERE e.event_id = s.event_id and e.event_slug = $1 and s.section_id = $2`,
      [eventSlug, sectionId]
    );
    return new Response('OK', {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: unknown) {

    const message = error instanceof Error ? error.message : "Unknown error";
    
    return new Response(message, {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
}
