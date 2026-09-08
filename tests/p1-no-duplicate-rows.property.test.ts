// Property test P1 — "No duplicate media rows per upload_id" — Task 13.3.
//
// Property P1 (design.md / tasks.md):
//   For all uploadId, COUNT(media WHERE upload_id = uploadId) <= 1, regardless
//   of retries, reload-restarts, or the reconciliation webhook firing after
//   confirm.
//   Validates: Requirements 7.7, 7.8, 13.3, 22.3
//
// This is a UNIT-level property against the real confirm POST handler
// (app/api/event/[event-slug]/media/confirm/route.ts). External boundaries are
// mocked exactly as in tests/confirm.route.test.ts (Task 13.2):
//   - `@/lib/db`      -> pool.query, dispatched by SQL text against an IN-MEMORY
//                        media table that enforces the ON CONFLICT (upload_id)
//                        unique constraint ATOMICALLY (the crux of this test).
//   - `@vercel/blob`  -> head (blob exists) / del (spy; must never fire on the
//                        happy P1 path) / BlobNotFoundError.
// REAL: `@/lib/auth` verifyRequest (a real signed JWT) and `@/lib/demo-guard`.
//
// The in-memory table is the AUTHORITATIVE synchronization primitive: it is a
// MODEL of a Postgres partial-unique index + `ON CONFLICT (upload_id) DO
// NOTHING`. It is NOT a real database (real DB proof is task 13.7). Concurrency
// here is modeled at the JS async-step (event-loop) interleaving level, not
// true OS-thread parallelism — see "Deviations" in the report.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import jwt from 'jsonwebtoken';
import { NextRequest } from 'next/server';

// --- Mock external boundaries BEFORE importing the route ----------------------
// `vi.mock` factories are hoisted; anything they reference must come from
// `vi.hoisted`. We expose mutable holders so each property run can install a
// fresh in-memory DB model without re-registering the mock.
const { dbState, headMock, delMock, FakeBlobNotFoundError } = vi.hoisted(() => {
    class FakeBlobNotFoundError extends Error {
        constructor() {
            super('Blob not found');
            this.name = 'BlobNotFoundError';
        }
    }
    // dbState.query is swapped per property run (rebuilt with a fresh model).
    const dbState: { query: (sql: string, params?: unknown[]) => Promise<unknown> } = {
        query: async () => {
            throw new Error('db model not initialised');
        },
    };
    return {
        dbState,
        headMock: vi.fn(),
        delMock: vi.fn(),
        FakeBlobNotFoundError,
    };
});

vi.mock('@/lib/db', () => ({
    default: { query: (sql: string, params?: unknown[]) => dbState.query(sql, params) },
}));

vi.mock('@vercel/blob', () => ({
    head: (...args: unknown[]) => headMock(...args),
    del: (...args: unknown[]) => delMock(...args),
    BlobNotFoundError: FakeBlobNotFoundError,
}));

// Import AFTER mocks are registered.
import { POST } from '@/app/api/event/[event-slug]/media/confirm/route';

// --- Fixtures (mirror tests/confirm.route.test.ts) ---------------------------

const TEST_SECRET = 'p1-property-test-secret';
const EVENT_ID = 12;
const SECTION_ID = 99;
const EVENT_SLUG = 'my-event';
const NORMAL_EMAIL = 'user@example.test';
const BLOB_HOST = 'https://blob.example.com';

function signToken(email: string): string {
    return jwt.sign({ userId: 5, email, isAdmin: false }, TEST_SECRET, {
        expiresIn: '1h',
    });
}

interface MediaRow {
    media_id: number;
    content: string;
    type: string;
    date: string;
    user_id: number;
    section_id: number;
    event_id: number;
    blurhash: string | null;
    upload_id: string;
}

// The in-memory "media table". Keyed by upload_id, this models the partial
// UNIQUE index (media_upload_id_key WHERE upload_id IS NOT NULL). The ONLY way a
// row is ever added is through the atomic INSERT-or-conflict step below.
interface MediaTableModel {
    query: (sql: string, params?: unknown[]) => Promise<unknown>;
    rowsFor: (uploadId: string) => MediaRow[];
    insertedCount: () => number;
}

function createMediaTableModel(): MediaTableModel {
    // upload_id -> the single row that exists for it (unique-constraint analog).
    const byUploadId = new Map<string, MediaRow>();
    let nextMediaId = 1;
    let insertAttempts = 0; // number of INSERTs that actually created a row (201s)

    async function query(sql: string, params?: unknown[]): Promise<unknown> {
        // 1. Event resolution.
        if (/FROM events/i.test(sql)) {
            return { rows: [{ event_id: EVENT_ID }] };
        }
        // 2. Section resolution (default 'Sin clasificar').
        if (/FROM sections/i.test(sql)) {
            return { rows: [{ section_id: SECTION_ID }] };
        }
        // 3. INSERT ... ON CONFLICT (upload_id) DO NOTHING RETURNING *
        //    THIS IS THE CRUX: a single, synchronous, ATOMIC check-and-insert.
        //    The parameter order in the route is:
        //    [content, type, date, user_id, section_id, event_id, blurhash, upload_id]
        //    so upload_id is the LAST param (index 7).
        if (/INSERT INTO media/i.test(sql)) {
            const p = params ?? [];
            const content = p[0] as string;
            const type = p[1] as string;
            const date = p[2] as string;
            const userId = p[3] as number;
            const sectionId = p[4] as number;
            const eventId = p[5] as number;
            const blurhash = (p[6] as string | null) ?? null;
            const uploadId = p[7] as string;

            // Atomic: if a row already exists for this upload_id, the unique
            // index rejects the insert -> ON CONFLICT DO NOTHING -> zero rows
            // returned. Otherwise create exactly one row. There is NO separate
            // "SELECT existence then INSERT" — the decision is indivisible,
            // exactly like Postgres enforcing the unique index atomically.
            if (byUploadId.has(uploadId)) {
                return { rows: [] }; // conflict: inserted nothing
            }
            const row: MediaRow = {
                media_id: nextMediaId++,
                content,
                type,
                date,
                user_id: userId,
                section_id: sectionId,
                event_id: eventId,
                blurhash,
                upload_id: uploadId,
            };
            byUploadId.set(uploadId, row);
            insertAttempts++;
            return { rows: [row] };
        }
        // 4. SELECT * FROM media WHERE upload_id = $1  (only on conflict path).
        if (/SELECT \* FROM media/i.test(sql)) {
            const uploadId = (params ?? [])[0] as string;
            const row = byUploadId.get(uploadId);
            return { rows: row ? [row] : [] };
        }
        // 5. shapeMediaRow's DTO enrichment SELECT (`... FROM users LEFT JOIN
        //    likes ...`). Added because confirm now returns a Media-DTO-shaped
        //    object (username/likes/liked) instead of the raw media row. A fresh
        //    row naturally has 0 likes / liked=false; username is a stable stub.
        if (/FROM users/i.test(sql)) {
            return { rows: [{ username: 'tester', likes: 0, liked: false }] };
        }
        throw new Error(`Unexpected query in P1 model: ${sql}`);
    }

    return {
        query,
        rowsFor: (uploadId: string) => {
            const row = byUploadId.get(uploadId);
            return row ? [row] : [];
        },
        insertedCount: () => insertAttempts,
    };
}

// A single confirmation attempt (client confirm OR reconciliation) always
// targets the SAME uploadId with valid, consistent data — the property is about
// repeated/interleaved confirmations of one upload.
function buildConfirmBody(
    uploadId: string,
    contentType: string,
    date: string,
    filename: string,
): Record<string, unknown> {
    return {
        uploadId,
        blobUrl: `${BLOB_HOST}/events/${EVENT_ID}/${uploadId}/${filename}`,
        filename,
        contentType,
        originalSize: 2_000_000,
        processedSize: 400_000,
        date,
        blurhash: 'LEHV6nWB2yk8',
    };
}

function makeRequest(body: Record<string, unknown>): NextRequest {
    const req = new NextRequest('https://example.test/api/confirm', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
    });
    req.cookies.set('auth_token', signToken(NORMAL_EMAIL));
    return req;
}

function params(): { params: Promise<{ 'event-slug': string }> } {
    return { params: Promise.resolve({ 'event-slug': EVENT_SLUG }) };
}

// --- fast-check generators ----------------------------------------------------

// A valid, consistent confirm scenario for ONE uploadId.
const scenarioArb = fc.record({
    // uuid v4 matches the route's UUID_RE (version nibble 4, variant 8-b).
    uploadId: fc.uuid({ version: 4 }),
    contentType: fc.constantFrom(
        'image/jpeg',
        'image/png',
        'image/webp',
        'video/mp4',
        'video/webm',
    ),
    // A valid ISO date the confirm body accepts (non-empty string). Generated
    // from an epoch-millis integer to guarantee a valid, in-range timestamp
    // (fc.date can otherwise yield an Invalid Date sentinel).
    date: fc
        .integer({
            min: Date.UTC(2020, 0, 1),
            max: Date.UTC(2035, 0, 1),
        })
        .map((ms) => new Date(ms).toISOString()),
    filename: fc
        .stringMatching(/^[a-z0-9]{1,12}$/)
        .map((s) => `${s || 'photo'}.jpg`),
    // Number of confirmation ATTEMPTS for the SAME uploadId (retries + a
    // reconciliation-style attempt): at least 2 so idempotency is exercised.
    attempts: fc.integer({ min: 2, max: 8 }),
});

// --- Assertions shared by sequential & concurrent variants -------------------

async function assertConverges(
    model: MediaTableModel,
    uploadId: string,
    responses: Response[],
): Promise<void> {
    // (a) P1 CORE: the DB holds AT MOST ONE row for this uploadId.
    expect(model.rowsFor(uploadId).length).toBeLessThanOrEqual(1);

    // Exactly one row exists (every attempt used valid data, so one must insert).
    expect(model.rowsFor(uploadId).length).toBe(1);

    // Only ONE attempt actually inserted a row in the DB model.
    expect(model.insertedCount()).toBe(1);

    // (b) CONVERGENCE: every completed attempt returned success (200 or 201) —
    // no attempt produced a duplicate or an integrity 500. A naive
    // SELECT-then-INSERT that raced would instead yield a conflict the route
    // mishandles (500 / non-row response) — caught here.
    const statuses = responses.map((r) => r.status);
    for (const status of statuses) {
        expect([200, 201]).toContain(status);
    }

    // Exactly one attempt inserted (201); the rest returned 200 (existing row).
    const inserted = statuses.filter((s) => s === 201);
    const existing = statuses.filter((s) => s === 200);
    expect(inserted.length).toBe(1);
    expect(existing.length).toBe(responses.length - 1);

    // All successful responses converge on the SAME logical row (same media_id).
    const bodies = await Promise.all(responses.map((r) => r.clone().json()));
    const mediaIds = new Set(bodies.map((b) => (b as MediaRow).media_id));
    expect(mediaIds.size).toBe(1);
    const theRow = model.rowsFor(uploadId)[0];
    expect([...mediaIds][0]).toBe(theRow.media_id);

    // (c) del was never called on the happy path (no orphan cleanup needed).
    expect(delMock).not.toHaveBeenCalled();
}

const originalSecret = process.env.JWT_SECRET;

beforeEach(() => {
    process.env.JWT_SECRET = TEST_SECRET;
});

afterEach(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

const NUM_RUNS = 150;

describe('P1 — no duplicate media rows per upload_id', () => {
    it('SEQUENTIAL: repeated confirmations of one uploadId converge on a single row', async () => {
        await fc.assert(
            fc.asyncProperty(scenarioArb, async (s) => {
                // Per-run isolation: fresh model + mocks so rows never leak
                // between generated cases (NOT beforeEach, which runs once).
                const model = createMediaTableModel();
                dbState.query = model.query;
                headMock.mockReset();
                delMock.mockReset();
                headMock.mockResolvedValue({ url: 'ok' });
                delMock.mockResolvedValue(undefined);

                const responses: Response[] = [];
                for (let i = 0; i < s.attempts; i++) {
                    const body = buildConfirmBody(s.uploadId, s.contentType, s.date, s.filename);
                    // await each attempt in turn (retries / lost-response replays
                    // / a later reconciliation-style confirm of the same id).
                    responses.push(await POST(makeRequest(body), params()));
                }

                await assertConverges(model, s.uploadId, responses);
            }),
            { numRuns: NUM_RUNS },
        );
    });

    it('CONCURRENT: interleaved confirmations of one uploadId converge on a single row', async () => {
        await fc.assert(
            fc.asyncProperty(scenarioArb, async (s) => {
                const model = createMediaTableModel();
                dbState.query = model.query;
                headMock.mockReset();
                delMock.mockReset();
                headMock.mockResolvedValue({ url: 'ok' });
                delMock.mockResolvedValue(undefined);

                // Fire all attempts WITHOUT awaiting between them so their async
                // steps (json parse, head, insert, select) interleave on the
                // event loop, then await them all together. Because the model's
                // INSERT-or-conflict is atomic, interleaved calls converge to
                // exactly one row even under this race.
                const pending: Promise<Response>[] = [];
                for (let i = 0; i < s.attempts; i++) {
                    const body = buildConfirmBody(s.uploadId, s.contentType, s.date, s.filename);
                    pending.push(POST(makeRequest(body), params()));
                }
                const responses = await Promise.all(pending);

                await assertConverges(model, s.uploadId, responses);
            }),
            { numRuns: NUM_RUNS },
        );
    });
});
