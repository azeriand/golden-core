//Create an event
import pool from '@/lib/db';
import { NextRequest } from 'next/server';

export async function POST(request: NextRequest) {
  // Parse the request body
  console.log('REQUEST', request)
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
 
  const result = await pool.query(
  `INSERT INTO events (event_name, event_slug)
   VALUES ($1, $2)
   RETURNING *`,
  [name, name.toLowerCase().replace(/\s+/g, '-')+'-'+date]
);
  
 
  return new Response(JSON.stringify(result.rows[0].event_slug), {
    status: 201,
    headers: { 'Content-Type': 'application/json' }
  });
}