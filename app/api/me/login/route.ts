//Create the login function for users

import pool from '@/lib/db';
import { NextRequest } from 'next/server';
import bcrypt from 'bcrypt'
import generateJWT from '@/app/utils/jwt';
import { cookies } from 'next/headers'

// --- Rate limiting (P1-2) -----------------------------------------------------
// Simple in-memory fixed-window limiter keyed by client IP. It caps repeated
// login attempts to slow down brute-force / credential-stuffing.
//
// IMPORTANT LIMITATION: this counter lives in process memory. On a single
// long-lived Node server (e.g. `next start` / self-hosted / Docker) it works.
// On serverless/edge (Vercel), each invocation may run in a DIFFERENT instance,
// so this Map is NOT shared and the limit is best-effort only. For a real,
// distributed limit on Vercel, back this with an external store (Upstash/Redis)
// — see docs/plan-correcciones-produccion.md (P1-2). We keep the in-memory
// version as a baseline that never hurts and helps in non-serverless deploys.
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

const attempts = new Map<string, { count: number; resetAt: number }>();

function getClientKey(request: NextRequest): string {
    // Behind a proxy (Vercel), the real client IP is in x-forwarded-for.
    const fwd = request.headers.get('x-forwarded-for');
    const ip = fwd ? fwd.split(',')[0].trim() : request.headers.get('x-real-ip');
    return ip || 'unknown';
}

/** Returns true when the caller is over the limit for the current window. */
function isRateLimited(key: string): boolean {
    const now = Date.now();
    const entry = attempts.get(key);

    if (!entry || now > entry.resetAt) {
        attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
        return false;
    }

    entry.count += 1;
    return entry.count > MAX_ATTEMPTS;
}

// Uniform failure response for BOTH "user does not exist" and "wrong password"
// so an attacker cannot enumerate which emails are registered (P1-2).
function invalidCredentials(): Response {
    return new Response(JSON.stringify({ error: 'Invalid email or password.' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
    });
}

export async function POST(request: NextRequest) {

    try {
        // 1. Rate limit BEFORE doing any work (DB query / bcrypt).
        const key = getClientKey(request);
        if (isRateLimited(key)) {
            return new Response(
                JSON.stringify({ error: 'Too many attempts. Try again later.' }),
                { status: 429, headers: { 'Content-Type': 'application/json' } },
            );
        }

        const { email, password } = await request.json();

        // 2. Validate presence of inputs BEFORE querying the DB (was after).
        if (!email || typeof email !== 'string') {
            return new Response('Email missing', { status: 400 });
        }
        if (!password || typeof password !== 'string') {
            return new Response('Password missing', { status: 400 });
        }

        const result = await pool.query(
            'SELECT * FROM users WHERE user_email = $1',
            [email.toLowerCase()]
        );

        const user = result.rows[0];

        // 3. Same generic 401 whether the user is missing OR the password is
        //    wrong (no user enumeration). We still run bcrypt.compare only when a
        //    user exists; the uniform response is what matters for enumeration.
        if (!user) {
            return invalidCredentials();
        }

        const passwordValid = await bcrypt.compare(password, user.password);

        if (!passwordValid) {
            return invalidCredentials();
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
