//Create or modify user AND get data for a specific user

import pool from '@/lib/db';
import { NextRequest } from 'next/server';
import bcrypt from 'bcrypt'
import generateJWT from '@/app/utils/jwt';
import { cookies } from 'next/headers'
import jwt from "jsonwebtoken";

const saltRounds = 10;

const hashedPassword = (password: string) => new Promise((resolve, reject) => {
  bcrypt.hash(password, saltRounds, (err, hash) => {
    if (err) return reject(err)
    return resolve(hash)
  });
})

interface JWTPayload {
  userId: number;
  email: string;
  isAdmin: boolean;
}

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

    const token = request.cookies.get("auth_token")?.value;

    if (!token) {
      return Response.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    const jwtSecret = process.env.JWT_SECRET;

    if (!jwtSecret) {
        return new Response("JWT_SECRET is not configured", {
            status: 500,
        });
    }

    const decoded = jwt.verify(
      token,
      jwtSecret
    ) as JWTPayload;

    const userId = decoded.userId;

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

export async function PUT(request: NextRequest) {
  const { username, email, password, isAdmin, eventId } = await request.json();

    const hashedPassword = await bcrypt.hash(password, 10)

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
      [username, email.toLowerCase(), hashedPassword, isAdmin, eventId]
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