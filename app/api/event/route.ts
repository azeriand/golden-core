// Create an event

import pool from '@/lib/db';
import { NextRequest } from 'next/server';
import { verifyRequest } from '@/lib/auth';

export async function POST(request: NextRequest) {
  const auth = verifyRequest(request);
  if (!auth.ok) {
    return auth.response;
  }

  if (!auth.user.isAdmin) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const { name, date } = await request.json();

  if (!name) {
    return new Response('Name missing', {
      status: 400,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  if (!date) {
    return new Response('Date missing', {
      status: 400,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO events (event_name, event_slug)
       VALUES ($1, $2)
       RETURNING *`,
      [name, name.toLowerCase().replace(/\s+/g, '-') + '-' + date]
    );

    return new Response(JSON.stringify(result.rows[0].event_slug), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: unknown) {
    // 23505 = unique_violation on events_event_slug_key: another event already
    // has this name+date slug. Return a clear 409 instead of an unhandled 500.
    if (typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505') {
      return Response.json(
        { error: 'An event with this name and date already exists' },
        { status: 409 },
      );
    }
    console.error('POST /api/event failed:', error);
    return Response.json({ error: 'Could not create event' }, { status: 500 });
  }
}
