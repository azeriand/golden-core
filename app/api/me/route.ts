//Create or modify user

import pool from '@/lib/db';
import { NextRequest } from 'next/server';
import bcrypt from 'bcrypt'

const saltRounds = 10;

const hashedPassword = (password: string) => new Promise((resolve, reject) => {
    bcrypt.hash(password, saltRounds, (err, hash) => {
      if (err) return reject(err)
      return resolve(hash)
    });
  })

export async function POST(request: NextRequest) {
    const { username, userEmail, password, isAdmin, eventId } = await request.json();

     if (!username) {
            return new Response('Username missing', {
                status: 400,
                headers: { 'Content-Type': 'text/plain' }
            })
        }

        if (!userEmail) {
            return new Response('User email missing', {
                status: 400,
                headers: { 'Content-Type': 'text/plain' }
            })
        }

        if (!password) {
            return new Response('Password missing', {
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

    const user = await pool.query(
    `SELECT user_id FROM users WHERE user_email = $1`,
    [userEmail]
    );

    if (user.rows.length > 0) {
        return new Response(JSON.stringify({ error: 'Usuario ya existe' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    const hash = await hashedPassword(password);
    
    const result = await pool.query(
        `INSERT INTO users (username, user_email, password, is_admin, event_id)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *`,
        [username, userEmail.toLowerCase(), hash, isAdmin, eventId]
    );

    return new Response(JSON.stringify(result.rows[0]), {
        status: 201,
        headers: { 'Content-Type': 'application/json' }
    }); 

}

export async function PUT(request: NextRequest) {
  const { username, userEmail, password, isAdmin, eventId } = await request.json();

    const hashedPassword = await bcrypt.hash(password, 10)

  if (!username) {
    return new Response('Username missing', {
        status: 400,
        headers: { 'Content-Type': 'text/plain' }
    })
  }

  if (!userEmail) {
    return new Response('User email missing', {
        status: 400,
        headers: { 'Content-Type': 'text/plain' }
    })
  }

  if (!password) {
    return new Response('Password missing', {
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
 
  try {
    const result = await pool.query(
      `UPDATE users
       SET username = $1, user_email = $2, password = $3, is_admin = $4
       WHERE event_id = $5`,
      [username, userEmail.toLowerCase(), hashedPassword, isAdmin, eventId]
    );
    return new Response('OK', {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
} catch (error: unknown) {
    return new Response(error.message, {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
}