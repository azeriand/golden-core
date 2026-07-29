//Create the login function for users

import pool from '@/lib/db';
import { NextRequest } from 'next/server';
import bcrypt from 'bcrypt'
import generateJWT from '@/app/utils/jwt';
import { cookies } from 'next/headers'

export async function POST(request: NextRequest) {

    try{
        const { email, password } = await request.json();

        const result = await pool.query(
            'SELECT * FROM users WHERE user_email = $1',
            [email.toLowerCase()]
        );

        const user = result.rows[0];

        if (!user) {
            return new Response(JSON.stringify({ error: 'User not found.' }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        if (!email) {
            return new Response("Email missing", {
                status: 400,
            });
        }

        if (!password) {
            return new Response("Password missing", {
                status: 400,
            });
        }

        const passwordValid = await bcrypt.compare(password, user.password);

        if (!passwordValid) {
            return new Response(JSON.stringify({ error: 'Incorrect login.' }), {
                status: 401,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const token = await generateJWT(user);

        const cookieStore = await cookies()

        cookieStore.set('auth_token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            path: '/',
            maxAge: 60 * 60 * 24 * 3
        });

        return Response.json({
            id: user.user_id,
            email: user.user_email,
            username: user.username
        });
    } catch (error: unknown) {

        console.error(error);

        return Response.json(
        { error: "Internal server error" },
        { status: 500 }
        );
    }

}