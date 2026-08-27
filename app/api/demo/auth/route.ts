// Auto-authenticate as the demo user

import pool from '@/lib/db';
import generateJWT from '@/app/utils/jwt';
import { cookies } from 'next/headers';

const DEMO_EMAIL = "demo@golden-core.app";

export async function POST() {
    const result = await pool.query(
        'SELECT * FROM users WHERE user_email = $1',
        [DEMO_EMAIL]
    );

    const user = result.rows[0];

    if (!user) {
        return Response.json(
            { error: "Demo user not configured. Create a user with email demo@golden-core.app in the database." },
            { status: 500 }
        );
    }

    const token = await generateJWT(user);

    const cookieStore = await cookies();

    cookieStore.set('auth_token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 60 * 60 * 24 * 3,
    });

    // Return the full user shape so the client can set the auth store directly,
    // avoiding a follow-up GET /api/me that could race the new cookie.
    return Response.json({
        id: user.user_id,
        username: user.username,
        email: user.user_email,
        isAdmin: user.is_admin,
        eventId: user.event_id,
    });
}
