// Unit tests for `verifyRequest` (lib/auth.ts) — Task 13.2.
//
// Exercises the REAL JWT verification helper against REAL `jsonwebtoken`
// signatures. Only the request object is faked (a minimal stand-in exposing the
// same `cookies.get('auth_token')?.value` accessor the helper reads), and the
// `JWT_SECRET` env var is set/cleared per case. No mocking of jwt — the crypto
// boundary is real application logic here.
//
// Covered acceptance criteria:
//   - Req 3.1/3.5: JWT verified from the `auth_token` cookie before proceeding.
//   - Req 3.2: missing/invalid JWT -> 401.
//   - Req 3.3: expired JWT -> 401.
//   - Req 3.4: JWT_SECRET missing -> 500.
//   - Req 17.2: extraction preserves behavior, no widened permissions
//     (payload is mapped 1:1 to AuthedUser).
//   - Req 19.6/19.13 (adjacent): failure responses carry no server internals.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { NextRequest } from 'next/server';
import { verifyRequest } from '@/lib/auth';

const TEST_SECRET = 'test-secret-for-verify-request';

// Build a NextRequest carrying (or omitting) an auth_token cookie. We construct
// a real NextRequest and set the cookie via its cookies API so the accessor the
// helper uses (`request.cookies.get('auth_token')?.value`) is exercised for
// real rather than through a hand-rolled stub.
function requestWithToken(token?: string): NextRequest {
    const req = new NextRequest('https://example.test/api/confirm', {
        method: 'POST',
    });
    if (token !== undefined) {
        req.cookies.set('auth_token', token);
    }
    return req;
}

const originalSecret = process.env.JWT_SECRET;

beforeEach(() => {
    process.env.JWT_SECRET = TEST_SECRET;
});

afterEach(() => {
    if (originalSecret === undefined) {
        delete process.env.JWT_SECRET;
    } else {
        process.env.JWT_SECRET = originalSecret;
    }
});

describe('verifyRequest', () => {
    it('returns ok:true with the mapped user for a valid token', () => {
        const token = jwt.sign(
            { userId: 42, email: 'user@example.test', isAdmin: true },
            TEST_SECRET,
            { expiresIn: '1h' },
        );

        const result = verifyRequest(requestWithToken(token));

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.user).toEqual({
                userId: 42,
                email: 'user@example.test',
                isAdmin: true,
            });
        }
    });

    it('does not widen permissions: isAdmin false stays false', () => {
        const token = jwt.sign(
            { userId: 7, email: 'plain@example.test', isAdmin: false },
            TEST_SECRET,
            { expiresIn: '1h' },
        );

        const result = verifyRequest(requestWithToken(token));

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.user.isAdmin).toBe(false);
            expect(result.user.userId).toBe(7);
        }
    });

    it('returns ok:false with a 401 response when the token is missing', () => {
        const result = verifyRequest(requestWithToken(undefined));

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.response.status).toBe(401);
        }
    });

    it('returns ok:false with a 401 response for a garbage/invalid token', () => {
        const result = verifyRequest(requestWithToken('not-a-real-jwt'));

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.response.status).toBe(401);
        }
    });

    it('returns ok:false with a 401 response for an expired token', () => {
        const token = jwt.sign(
            { userId: 1, email: 'expired@example.test', isAdmin: false },
            TEST_SECRET,
            { expiresIn: '-1s' }, // already expired
        );

        const result = verifyRequest(requestWithToken(token));

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.response.status).toBe(401);
        }
    });

    it('returns ok:false with a 401 for a token signed with a different secret', () => {
        const token = jwt.sign(
            { userId: 1, email: 'wrong@example.test', isAdmin: false },
            'a-completely-different-secret',
            { expiresIn: '1h' },
        );

        const result = verifyRequest(requestWithToken(token));

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.response.status).toBe(401);
        }
    });

    it('returns ok:false with a 500 response when JWT_SECRET is not configured', () => {
        // Sign while a secret exists, then remove it before verifying so the
        // missing-secret branch is what fails (not an invalid signature).
        const token = jwt.sign(
            { userId: 1, email: 'nosecret@example.test', isAdmin: false },
            TEST_SECRET,
            { expiresIn: '1h' },
        );
        delete process.env.JWT_SECRET;

        const result = verifyRequest(requestWithToken(token));

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.response.status).toBe(500);
        }
    });

    it('does not leak the secret or token in the failure response body', async () => {
        const result = verifyRequest(requestWithToken('garbage'));
        expect(result.ok).toBe(false);
        if (!result.ok) {
            const text = await result.response.text();
            expect(text).not.toContain(TEST_SECRET);
            expect(text).not.toContain('garbage');
        }
    });
});
