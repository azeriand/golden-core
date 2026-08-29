// Unit tests for the confirm route POST handler — Task 13.2.
// app/api/event/[event-slug]/media/confirm/route.ts
//
// Mocks ONLY external boundaries:
//   - `@/lib/db`  -> pool.query (a vi.fn we sequence per query the handler runs)
//   - `@vercel/blob` -> head / del / BlobNotFoundError
// REAL: `@/lib/auth` verifyRequest (exercised with a real signed JWT) and
//       `@/lib/demo-guard` (real slug/email checks).
//
// NOTE ON "insertMediaIdempotent": the task names it as a unit, but the confirm
// route performs the idempotent insert INLINE
// (`INSERT ... ON CONFLICT (upload_id) DO NOTHING RETURNING *` then a
// SELECT-on-conflict). There is no exported helper to test in isolation and we
// MUST NOT refactor production for testability. So the idempotency behavior is
// covered here at the confirm-route level (inserted -> 201; conflict/0 rows ->
// SELECT existing -> 200). The concurrent-interleaving PROPERTY (P1) is task 13.3.
//
// Covered acceptance criteria: Req 3.5/3.6 (auth), 4.2/4.5 (demo event/user 403,
// no row), 7.3/7.4/7.9 (uuid + malformed -> 400), 8.1/8.2 (DB fail -> del + 500,
// no row), 7.6/22 (idempotent existing row -> 200), 19.6/19.13 (generic message,
// no internals). Blob-not-found (409) is included as part of confirm's unit
// behavior.
import {
    describe,
    it,
    expect,
    vi,
    beforeEach,
    afterEach,
} from 'vitest';
import jwt from 'jsonwebtoken';
import { NextRequest } from 'next/server';

// --- Mock external boundaries BEFORE importing the route ----------------------
// `vi.mock` factories are hoisted above imports, so any values they close over
// must be created via `vi.hoisted` (also hoisted) rather than as ordinary
// top-level consts.
const { queryMock, headMock, delMock, FakeBlobNotFoundError } = vi.hoisted(() => {
    class FakeBlobNotFoundError extends Error {
        constructor() {
            super('Blob not found');
            this.name = 'BlobNotFoundError';
        }
    }
    return {
        queryMock: vi.fn(),
        headMock: vi.fn(),
        delMock: vi.fn(),
        FakeBlobNotFoundError,
    };
});

vi.mock('@/lib/db', () => ({
    default: { query: (...args: unknown[]) => queryMock(...args) },
}));

vi.mock('@vercel/blob', () => ({
    head: (...args: unknown[]) => headMock(...args),
    del: (...args: unknown[]) => delMock(...args),
    BlobNotFoundError: FakeBlobNotFoundError,
}));

// Import AFTER mocks are registered.
import { POST } from '@/app/api/event/[event-slug]/media/confirm/route';

// --- Fixtures ----------------------------------------------------------------

const TEST_SECRET = 'confirm-route-test-secret';
const VALID_UUID = '11111111-1111-4111-8111-111111111111';
const EVENT_ID = 12;
const SECTION_ID = 99;
const FIXED_DATE = '2024-01-15T10:30:00.000Z';
const EVENT_SLUG = 'my-event';
const DEMO_EMAIL = 'demo@golden-core.app';
const NORMAL_EMAIL = 'user@example.test';
const USERNAME = 'tester';

function signToken(email: string): string {
    return jwt.sign(
        { userId: 5, email, isAdmin: false },
        TEST_SECRET,
        { expiresIn: '1h' },
    );
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        uploadId: VALID_UUID,
        blobUrl: `https://blob.example.com/events/${EVENT_ID}/${VALID_UUID}/photo-abc.jpg`,
        filename: 'photo.jpg',
        contentType: 'image/jpeg',
        originalSize: 2_000_000,
        processedSize: 400_000,
        date: FIXED_DATE,
        blurhash: 'LEHV6nWB2yk8',
        ...overrides,
    };
}

function makeRequest(
    body: unknown,
    { email = NORMAL_EMAIL, withToken = true }: { email?: string; withToken?: boolean } = {},
): NextRequest {
    const req = new NextRequest('https://example.test/api/confirm', {
        method: 'POST',
        body: typeof body === 'string' ? body : JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
    });
    if (withToken) {
        req.cookies.set('auth_token', signToken(email));
    }
    return req;
}

function params(slug = EVENT_SLUG): { params: Promise<{ 'event-slug': string }> } {
    return { params: Promise.resolve({ 'event-slug': slug }) };
}

// Query router: dispatch mocked responses based on the SQL text so the tests do
// not rely on brittle call ordering. Mirrors the handler's query order:
//   1. SELECT event_id FROM events ...
//   2. SELECT section_id FROM sections ...
//   3. INSERT INTO media ... ON CONFLICT ... RETURNING *
//   4. SELECT * FROM media WHERE upload_id = $1   (only on conflict)
interface QueryPlan {
    event?: unknown[]; // rows for the events SELECT
    section?: unknown[]; // rows for the sections SELECT
    insert?: unknown[] | (() => never); // rows for INSERT, or a thrower
    existing?: unknown[]; // rows for the on-conflict SELECT
    // rows for shapeMediaRow's DTO-enrichment SELECT (`... FROM users LEFT JOIN
    // likes ...`). Defaults to a stable username with 0 likes / liked=false —
    // the natural values for a freshly created media row.
    userMeta?: unknown[];
}

function planQueries(plan: QueryPlan): void {
    queryMock.mockImplementation(async (sql: string) => {
        if (/FROM events/i.test(sql)) {
            return { rows: plan.event ?? [{ event_id: EVENT_ID }] };
        }
        if (/FROM sections/i.test(sql)) {
            return { rows: plan.section ?? [{ section_id: SECTION_ID }] };
        }
        if (/INSERT INTO media/i.test(sql)) {
            if (typeof plan.insert === 'function') {
                (plan.insert as () => never)();
            }
            return { rows: plan.insert ?? [] };
        }
        if (/SELECT \* FROM media/i.test(sql)) {
            return { rows: plan.existing ?? [] };
        }
        // shapeMediaRow's DTO enrichment SELECT: confirm now returns a
        // Media-DTO-shaped object (username/likes/liked) rather than the raw
        // media row, so the mock must answer this query on the success paths.
        if (/FROM users/i.test(sql)) {
            return {
                rows: plan.userMeta ?? [
                    { username: USERNAME, likes: 0, liked: false },
                ],
            };
        }
        throw new Error(`Unexpected query in test: ${sql}`);
    });
}

const originalSecret = process.env.JWT_SECRET;

beforeEach(() => {
    process.env.JWT_SECRET = TEST_SECRET;
    queryMock.mockReset();
    headMock.mockReset();
    delMock.mockReset();
    headMock.mockResolvedValue({ url: 'ok' });
    delMock.mockResolvedValue(undefined);
});

afterEach(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
    vi.restoreAllMocks();
});

describe('confirm route — demo protection', () => {
    it('returns 403 for a demo event and creates no row', async () => {
        planQueries({});
        const res = await POST(makeRequest(validBody()), params('demo'));

        expect(res.status).toBe(403);
        expect(queryMock).not.toHaveBeenCalled();
    });

    it('returns 403 for the demo user and creates no row', async () => {
        planQueries({});
        const res = await POST(
            makeRequest(validBody(), { email: DEMO_EMAIL }),
            params(),
        );

        expect(res.status).toBe(403);
        // Demo-user rejection happens before any DB work.
        expect(queryMock).not.toHaveBeenCalled();
    });
});

describe('confirm route — authentication', () => {
    it('returns 401 when the auth token is missing and creates no row', async () => {
        planQueries({});
        const res = await POST(
            makeRequest(validBody(), { withToken: false }),
            params(),
        );

        expect(res.status).toBe(401);
        expect(queryMock).not.toHaveBeenCalled();
    });

    it('returns 500 when JWT_SECRET is not configured', async () => {
        delete process.env.JWT_SECRET;
        planQueries({});
        const res = await POST(makeRequest(validBody()), params());

        expect(res.status).toBe(500);
        expect(queryMock).not.toHaveBeenCalled();
    });
});

describe('confirm route — body validation (400, no row)', () => {
    it('returns 400 for malformed JSON', async () => {
        planQueries({});
        const res = await POST(makeRequest('{not json'), params());

        expect(res.status).toBe(400);
        expect(queryMock).not.toHaveBeenCalled();
    });

    it('returns 400 when uploadId is not a valid UUID', async () => {
        planQueries({});
        const res = await POST(
            makeRequest(validBody({ uploadId: 'not-a-uuid' })),
            params(),
        );

        expect(res.status).toBe(400);
        expect(queryMock).not.toHaveBeenCalled();
    });

    it('returns 400 when a required field is missing (blobUrl)', async () => {
        planQueries({});
        const body = validBody();
        delete body.blobUrl;
        const res = await POST(makeRequest(body), params());

        expect(res.status).toBe(400);
        expect(queryMock).not.toHaveBeenCalled();
    });

    it('returns 400 for an unsupported content type', async () => {
        planQueries({});
        const res = await POST(
            makeRequest(validBody({ contentType: 'application/zip' })),
            params(),
        );

        expect(res.status).toBe(400);
        expect(queryMock).not.toHaveBeenCalled();
    });
});

describe('confirm route — blob/event mismatch', () => {
    it('returns 400 when the blobUrl is not under this event/upload prefix', async () => {
        planQueries({}); // event resolves to EVENT_ID
        const res = await POST(
            makeRequest(
                validBody({
                    blobUrl: `https://blob.example.com/events/999/${VALID_UUID}/x.jpg`,
                }),
            ),
            params(),
        );

        expect(res.status).toBe(400);
        // Event was resolved, but no INSERT should have run.
        const insertCalled = queryMock.mock.calls.some((c) =>
            /INSERT INTO media/i.test(c[0] as string),
        );
        expect(insertCalled).toBe(false);
    });
});

describe('confirm route — event resolution', () => {
    it('returns 404 when the event does not exist', async () => {
        planQueries({ event: [] });
        const res = await POST(makeRequest(validBody()), params());

        expect(res.status).toBe(404);
    });
});

describe('confirm route — blob existence check', () => {
    it('returns 409 when head() reports the blob is not found', async () => {
        planQueries({});
        headMock.mockRejectedValueOnce(new FakeBlobNotFoundError());

        const res = await POST(makeRequest(validBody()), params());

        expect(res.status).toBe(409);
        const insertCalled = queryMock.mock.calls.some((c) =>
            /INSERT INTO media/i.test(c[0] as string),
        );
        expect(insertCalled).toBe(false);
    });
});

describe('confirm route — idempotent insert', () => {
    it('returns 201 with a Media-DTO-shaped body (username/likes/liked) on a fresh insert', async () => {
        const insertedRow = {
            media_id: 1,
            upload_id: VALID_UUID,
            content: 'url',
            user_id: 5,
            type: 'image/jpeg',
            date: FIXED_DATE,
            section_id: SECTION_ID,
            blurhash: 'LEHV6nWB2yk8',
        };
        planQueries({ insert: [insertedRow] });

        const res = await POST(makeRequest(validBody()), params());

        expect(res.status).toBe(201);
        const body = await res.json();
        // Media DTO shape: mirrors GET's per-media object exactly.
        expect(body).toMatchObject({
            media_id: 1,
            user_id: 5,
            content: 'url',
            type: 'image/jpeg',
            section_id: SECTION_ID,
            blurhash: 'LEHV6nWB2yk8',
            date: FIXED_DATE,
        });
        // Enriched (joined) fields a raw INSERT ... RETURNING * lacks.
        expect(body).toHaveProperty('username', USERNAME);
        expect(body).toHaveProperty('likes', 0);
        expect(body).toHaveProperty('liked', false);
    });

    it('persists the date carried in the confirm body (not a fresh time)', async () => {
        planQueries({ insert: [{ media_id: 1, upload_id: VALID_UUID }] });

        await POST(makeRequest(validBody()), params());

        const insertCall = queryMock.mock.calls.find((c) =>
            /INSERT INTO media/i.test(c[0] as string),
        );
        expect(insertCall).toBeTruthy();
        const insertValues = insertCall![1] as unknown[];
        // The date value must be the fixed body date, at its expected position.
        expect(insertValues).toContain(FIXED_DATE);
    });

    it('returns 200 with a Media-DTO-shaped existing row when ON CONFLICT yields no inserted row', async () => {
        const existingRow = {
            media_id: 7,
            upload_id: VALID_UUID,
            content: 'existing',
            user_id: 5,
            type: 'image/jpeg',
            date: FIXED_DATE,
            section_id: SECTION_ID,
            blurhash: null,
        };
        // An already-liked, already-liked-by-others existing row exercises the
        // likes/liked enrichment on the 200 path.
        planQueries({
            insert: [],
            existing: [existingRow],
            userMeta: [{ username: USERNAME, likes: 3, liked: true }],
        });

        const res = await POST(makeRequest(validBody()), params());

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toMatchObject({
            media_id: 7,
            user_id: 5,
            content: 'existing',
            type: 'image/jpeg',
            section_id: SECTION_ID,
            blurhash: null,
        });
        expect(body).toHaveProperty('username', USERNAME);
        expect(body).toHaveProperty('likes', 3);
        expect(body).toHaveProperty('liked', true);
        // The follow-up SELECT for the existing row ran.
        const selectCalled = queryMock.mock.calls.some((c) =>
            /SELECT \* FROM media/i.test(c[0] as string),
        );
        expect(selectCalled).toBe(true);
    });

    it('returns 500 (integrity) when more than one row exists for the uploadId', async () => {
        planQueries({
            insert: [],
            existing: [
                { media_id: 1, upload_id: VALID_UUID },
                { media_id: 2, upload_id: VALID_UUID },
            ],
        });

        const res = await POST(makeRequest(validBody()), params());

        expect(res.status).toBe(500);
        // Integrity guard must NEVER silently delete rows.
        expect(delMock).not.toHaveBeenCalled();
    });
});

describe('confirm route — DB failure cleanup', () => {
    it('deletes the blob and returns a generic 500 when the INSERT fails', async () => {
        planQueries({
            insert: () => {
                throw new Error('db exploded: connection refused at 10.0.0.1');
            },
        });

        const res = await POST(makeRequest(validBody()), params());

        expect(res.status).toBe(500);
        // Best-effort blob cleanup was attempted with the blob URL.
        expect(delMock).toHaveBeenCalledTimes(1);
        expect(delMock.mock.calls[0][0]).toBe(validBody().blobUrl);

        // Generic message, no server internals leaked (Req 19.6/19.13).
        const text = await res.text();
        expect(text).toContain('Could not save media');
        expect(text).not.toContain('connection refused');
        expect(text).not.toContain('db exploded');
    });
});
