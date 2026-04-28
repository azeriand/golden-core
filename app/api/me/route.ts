//Create or modify user

import pool from '@/lib/db';
import { NextRequest } from 'next/server';

export async function POST(request: NextRequest) {
  const { username, device, isAdmin, eventId } = await request.json();

  if (!username) {
    return new Response('Username missing', {
        status: 400,
        headers: { 'Content-Type': 'text/plain' }
    })
  }

  if (!device) {
    return new Response('Device missing', {
        status: 400,
        headers: { 'Content-Type': 'text/plain' }
    })
  }

  if (isAdmin === undefined) {
    return new Response('Range missing', {
        status: 400,
        headers: { 'Content-Type': 'text/plain' }
    })
  }

  if (!eventId) {
    return new Response('Event ID missing', {
        status: 400,
        headers: { 'Content-Type': 'text/plain' }
    })
  }

  const result = await pool.query(
    `INSERT INTO users (username, device, is_admin, event_id)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [username, device, isAdmin, eventId]
  );

  return new Response(JSON.stringify(result.rows[0]), {
    status: 201,
    headers: { 'Content-Type': 'application/json' }
  });

}
