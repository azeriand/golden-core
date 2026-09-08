// Create an event

import pool from '@/lib/db';
import { NextRequest } from 'next/server';
import jwt from 'jsonwebtoken';

export async function POST(request: NextRequest) {
  const token = request.cookies.get("auth_token")?.value;

  if (!token) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const jwtSecret = process.env.JWT_SECRET;

  if (!jwtSecret) {
    return Response.json({ error: "JWT_SECRET is not configured" }, { status: 500 });
  }

  let decoded: any;
  try {
    decoded = jwt.verify(token, jwtSecret) as any;
  } catch {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!decoded.isAdmin) {
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
}
