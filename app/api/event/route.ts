//Create an event
import pool from '@/lib/db';

export async function POST(request: Request) {
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
  `INSERT INTO sessions (session_id, session_name, session_slug)
   VALUES (uuid_generate_v1(), $1, $2)
   RETURNING *`,
  [name, name.toLowerCase().replace(/\s+/g, '-')+'-'+date]
);
  
 
  return new Response(JSON.stringify(result.rows[0].session_slug), {
    status: 201,
    headers: { 'Content-Type': 'application/json' }
  });
}