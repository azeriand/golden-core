//Create the login function for users

import pool from '@/lib/db';
import { NextRequest } from 'next/server';
import bcrypt from 'bcrypt'
import generateJWT from '@/app/utils/jwt';
import { cookies } from 'next/headers'

export async function POST(request: NextRequest) {
    const { userEmail, password } = await request.json();

    const result = await pool.query(
        'SELECT * FROM users WHERE user_email = $1',
        [userEmail.toLowerCase()]
    );

    const user = result.rows[0];

    if (!user) {
        return new Response(JSON.stringify({ error: 'User not found.' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    const passwordValid = await bcrypt.compare(password, user.password);
    const validEmail = String(userEmail)
        .toLowerCase()
        .match(/^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|.(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/
    );

    if (!passwordValid || !validEmail) {
        return new Response(JSON.stringify({ error: 'Incorrect login.' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    const token = await generateJWT(result.rows[0]);

    const cookieStore = await cookies()

    cookieStore.set('auth_token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 60 * 60 * 24 * 3
    });

    return new Response(JSON.stringify(user), {
        status: 201,
        headers: { 'Content-Type': 'application/json' }
    });

}