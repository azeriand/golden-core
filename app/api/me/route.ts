//Create or modify user AND get data for a specific user

import pool from '@/lib/db';
import { NextRequest } from 'next/server';
import bcrypt from 'bcrypt'
import generateJWT from '@/app/utils/jwt';
import { cookies } from 'next/headers'
import { verifyRequest } from '@/lib/auth';

const saltRounds = 10;

const hashedPassword = (password: string) => new Promise((resolve, reject) => {
  bcrypt.hash(password, saltRounds, (err, hash) => {
    if (err) return reject(err)
    return resolve(hash)
  });
})

export async function POST(request: NextRequest) {

  try{
    const { username, email, password, eventId } = await request.json();
    const isAdmin = false;

    if (!username) {
        return new Response('Username missing', {
          status: 400,
          headers: { 'Content-Type': 'text/plain' }
        })
    }

    if (!email) {
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

    if (!eventId) {
        return new Response('Event ID missing', {
          status: 400,
          headers: { 'Content-Type': 'text/plain' }
        })
    }

    const existingUser = await pool.query(
      `SELECT  * FROM users WHERE user_email = $1`,
      [email.toLowerCase()]
    );

    if (existingUser.rows.length > 0) {
      return new Response('User already exists', {
        status: 409,
        headers: { 'Content-Type': 'text/plain' }
      })
    }
    const hash = await hashedPassword(password);
    
    const result = await pool.query(
        `INSERT INTO users (username, user_email, password, is_admin, event_id)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *`,
        [username, email.toLowerCase(), hash, isAdmin, eventId]
    );

    const user = result.rows[0];
    const token = await generateJWT(user);

    const cookieStore = await cookies()

    cookieStore.set('auth_token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 60 * 60 * 24 * 3
    });


    return new Response(JSON.stringify({ id: user.user_id, email: user.user_email, username: user.username }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: unknown) {

    console.error(error);

    return Response.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {

  try {

    const auth = verifyRequest(request);
    if (!auth.ok) {
      return auth.response;
    }
    const userId = auth.user.userId;

    const result = await pool.query(
      'SELECT * FROM users WHERE user_id = $1',
      [userId]
    );

    const user = result.rows[0];

    if (!user) {
      return Response.json(
          { error: "User not found" },
          { status: 404 }
      );
    }

    return Response.json({
      id: user.user_id,
      username: user.username,
      email: user.user_email,
      isAdmin: user.is_admin,
      eventId: user.event_id
    });

  } catch(error) {

    return Response.json(
      { error: "Invalid token" },
      { status: 401 }
  );

  }
}

// Basic email format check (server-side). Keeps parity with the client without
// pulling in a dependency; the DB is still the source of truth for uniqueness.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function PUT(request: NextRequest) {
  // GUARD: this admin user-management endpoint is NOT wired into the app yet.
  // It stays disabled (503) unless explicitly enabled via env, so it can never
  // be executed by accident before a proper management UI exists. Flip
  // ENABLE_USER_ADMIN_API=true to turn it on.
  if (process.env.ENABLE_USER_ADMIN_API !== 'true') {
    return new Response('Not available', { status: 503 });
  }

  // Require authentication (centralized in lib/auth.ts).
  const auth = verifyRequest(request);
  if (!auth.ok) {
    return auth.response;
  }

  // Only admins can update users
  if (!auth.user.isAdmin) {
    return new Response("Forbidden", { status: 403 });
  }

  const { userId, username, email, password, isAdmin, eventId } = await request.json();

  // The target user MUST be identified explicitly. This is the fix for the
  // original bug where the UPDATE keyed on event_id and rewrote EVERY user in
  // the event at once.
  if (typeof userId !== 'number' || !Number.isFinite(userId)) {
    return new Response('userId missing or invalid', {
      status: 400,
      headers: { 'Content-Type': 'text/plain' }
    });
  }

  if (email !== undefined && (typeof email !== 'string' || !EMAIL_RE.test(email))) {
    return new Response('Invalid email', {
      status: 400,
      headers: { 'Content-Type': 'text/plain' }
    });
  }

  // Build a partial update from ONLY the fields that were provided, so a caller
  // can change one field without wiping the rest. The password is only
  // re-hashed when a non-empty value is sent (C1).
  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (username !== undefined) {
    if (typeof username !== 'string' || username.length === 0) {
      return new Response('Invalid username', {
        status: 400,
        headers: { 'Content-Type': 'text/plain' }
      });
    }
    sets.push(`username = $${i++}`);
    values.push(username);
  }

  if (email !== undefined) {
    sets.push(`user_email = $${i++}`);
    values.push(email.toLowerCase());
  }

  if (password !== undefined && password !== null && password !== '') {
    if (typeof password !== 'string') {
      return new Response('Invalid password', {
        status: 400,
        headers: { 'Content-Type': 'text/plain' }
      });
    }
    const hash = await bcrypt.hash(password, saltRounds);
    sets.push(`password = $${i++}`);
    values.push(hash);
  }

  if (isAdmin !== undefined) {
    if (typeof isAdmin !== 'boolean') {
      return new Response('Invalid isAdmin', {
        status: 400,
        headers: { 'Content-Type': 'text/plain' }
      });
    }
    sets.push(`is_admin = $${i++}`);
    values.push(isAdmin);
  }

  if (eventId !== undefined) {
    if (typeof eventId !== 'number' || !Number.isFinite(eventId)) {
      return new Response('Invalid eventId', {
        status: 400,
        headers: { 'Content-Type': 'text/plain' }
      });
    }
    sets.push(`event_id = $${i++}`);
    values.push(eventId);
  }

  if (sets.length === 0) {
    return new Response('No fields to update', {
      status: 400,
      headers: { 'Content-Type': 'text/plain' }
    });
  }

  // userId is the LAST parameter, targeting exactly one row.
  values.push(userId);

  try {
    const result = await pool.query(
      `UPDATE users
       SET ${sets.join(', ')}
       WHERE user_id = $${i}`,
      values
    );

    if (result.rowCount === 0) {
      return new Response('User not found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain' }
      });
    }

    return new Response('OK', {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: unknown) {
    // Do not leak DB internals to the client.
    console.error('PUT /api/me update failed:', error);
    return new Response('Could not update user', {
      status: 400,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}