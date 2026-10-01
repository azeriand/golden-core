// Centralized JWT verification for request-authenticated routes.
//
// This module EXTRACTS the existing JWT verification logic that is currently
// duplicated across API routes (e.g. `app/api/event/[event-slug]/media/route.ts`
// and `app/api/me/route.ts`) into a single reusable helper. It does NOT widen
// permissions and does NOT change the existing auth/session behavior:
//   - reads the `auth_token` httpOnly cookie
//   - returns 401 when the token is missing, invalid, or expired
//   - returns 500 when `JWT_SECRET` is not configured
//   - maps the JWT payload `{ userId, email, isAdmin }` to `AuthedUser`
//
// The token is minted in `app/utils/jwt.ts` with exactly this payload shape.
// New routes should consume this helper so they enforce identical rules;
// existing (legacy) routes are intentionally left untouched.

import { NextRequest } from 'next/server';
import jwt from 'jsonwebtoken';

export interface AuthedUser {
    userId: number;
    email: string;
    isAdmin: boolean;
}

// Mirrors the JWT payload signed in `app/utils/jwt.ts`.
interface JWTPayload {
    userId: number;
    email: string;
    isAdmin: boolean;
}

/**
 * Verifies the JWT in the `auth_token` cookie of an incoming request.
 *
 * Returns `{ ok: true, user }` with the decoded user on success, or
 * `{ ok: false, response }` carrying a short-circuit `Response` on failure:
 *   - 401 when the token is missing, invalid, or expired
 *   - 500 when `JWT_SECRET` is not configured
 *
 * This is a faithful extraction of the existing per-route verification logic;
 * it never widens permissions.
 */
export function verifyRequest(request: NextRequest):
    | { ok: true; user: AuthedUser }
    | { ok: false; response: Response } {

    const token = request.cookies.get('auth_token')?.value;

    if (!token) {
        return { ok: false, response: new Response('Unauthorized', { status: 401 }) };
    }

    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
        return {
            ok: false,
            response: new Response('JWT_SECRET is not configured', { status: 500 }),
        };
    }

    let decoded: JWTPayload;
    try {
        decoded = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] }) as JWTPayload;
    } catch {
        return { ok: false, response: new Response('Unauthorized', { status: 401 }) };
    }

    return {
        ok: true,
        user: {
            userId: decoded.userId,
            email: decoded.email,
            isAdmin: decoded.isAdmin,
        },
    };
}

/**
 * Requires that the user is an administrator.
 *
 * Checks the result of `verifyRequest` and returns a short-circuit `Response`
 * if the user is not authenticated or not an admin:
 *   - Returns the auth failure response if verification failed (401 or 500)
 *   - Returns 403 Forbidden if the user is authenticated but not an admin
 *   - Returns `null` if the user is authenticated AND is an admin
 *
 * Usage pattern in admin endpoints:
 * ```
 * const authResult = verifyRequest(request);
 * const errorResponse = requireAdmin(authResult);
 * if (errorResponse) return errorResponse;
 * // Now authResult.user.isAdmin is guaranteed to be true
 * ```
 */
export function requireAdmin(
    authResult: ReturnType<typeof verifyRequest>
): Response | null {
    if (!authResult.ok) {
        return authResult.response;
    }

    if (!authResult.user.isAdmin) {
        return new Response(
            JSON.stringify({ error: 'Forbidden: Admin access required' }),
            { 
                status: 403,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    }

    return null;
}
