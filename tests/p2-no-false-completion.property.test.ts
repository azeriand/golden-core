// Property test P2 — "No false completion" — Task 13.6.
//
// Property P2 (design.md P2 "No orphaned rows" + Req 20/21, phrased as the
// completion-consistency invariant this test enforces):
//   A SUCCESS response from the confirm route (200 or 201) exists IF AND ONLY IF
//   exactly one real `media` row exists for that uploadId in the DB model, and
//   the returned body's media_id matches that row. Conversely EVERY non-2xx
//   response corresponds to ZERO fabricated completion (no row is created), and
//   every server error (5xx) carries the generic message with NO server
//   internals leaked.
//   Validates: Requirements 20.1, 20.2, 20.3, 21.1, 21.4, 8.1, 8.2, 8.5,
//   19.6, 19.13.
//
// This is a UNIT-level property against the REAL confirm POST handler
// (app/api/event/[event-slug]/media/confirm/route.ts). External boundaries are
// mocked exactly as in tests/confirm.route.test.ts / p1:
//   - `@/lib/db`      -> pool.query, dispatched by SQL text against an IN-MEMORY
//                        media model that enforces ON CONFLICT (upload_id)
//                        atomically and OBSERVES the true row count. It also
//                        supports INJECTING a real INSERT failure (a thrown DB
//                        error carrying secret-ish internals) to drive the
//                        DB-fail branch.
//   - `@vercel/blob`  -> head (existing / BlobNotFound / unexpected throw) and
//                        del (spy) / BlobNotFoundError.
// REAL: `@/lib/auth` verifyRequest (real signed JWT) and `@/lib/demo-guard`.
//
// The in-memory model is a MODEL of a Postgres partial-unique index, NOT a real
// database (real DB proof is task 13.7). "Success ⟺ row exists" is observable
// because the model tracks the authoritative row set.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import jwt from 'jsonwebtoken';
import { NextRequest } from 'next/server';

// --- Mock external boundaries BEFORE importing the route ----------------------
const { dbState, headMock, delMock, FakeBlobNotFoundError } = vi.hoisted(() => {
    class FakeBlobNotFoundError extends Error {
        constructor() {
            super('Blob not found');
            this.name = 'BlobNotFoundError';
        }
    }
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

import { POST } from '@/app/api/event/[event-slug]/media/confirm/route';

// --- Fixtures ----------------------------------------------------------------

const TEST_SECRET = 'p2-property-test-secret';
const EVENT_ID = 12;
const SECTION_ID = 99;
const EVENT_SLUG = 'my-event';
const NORMAL_EMAIL = 'user@example.test';
const BLOB_HOST = 'https://blob.example.com';

// Injected DB failure carries secret-ish internals that MUST NOT leak (Req 19.13).
const DB_ERROR_MESSAGE = 'db exploded: connection refused at 10.0.0.1 password=hunter2';

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

// Behaviour knobs for a single scenario (drive the confirm branches).
interface ModelOpts {
    // Whether the INSERT should throw a genuine (non-conflict) DB error.
    insertThrows?: boolean;
    // Seed an existing row for the uploadId (idempotent-existing path).
    seedExisting?: MediaRow;
    // Force the on-conflict SELECT to return >1 row (integrity guard path).
    integrityDuplicate?: boolean;
    // Force the on-conflict SELECT to return 0 rows (conflict-then-missing path).
    conflictThenMissing?: boolean;
}

interface MediaTableModel {
    query: (sql: string, params?: unknown[]) => Promise<unknown>;
    rowsFor: (uploadId: string) => MediaRow[];
    totalRows: () => number;
    insertedCount: () => number;
}

function createMediaTableModel(opts: ModelOpts = {}): MediaTableModel {
    const byUploadId = new Map<string, MediaRow>();
    if (opts.seedExisting) byUploadId.set(opts.seedExisting.upload_id, { ...opts.seedExisting });
    let nextMediaId = 5000;
    let insertedCount = 0;

    async function query(sql: string, params?: unknown[]): Promise<unknown> {
        if (/FROM events/i.test(sql)) {
            return { rows: [{ event_id: EVENT_ID }] };
        }
        if (/FROM sections/i.test(sql)) {
            return { rows: [{ section_id: SECTION_ID }] };
        }
        if (/INSERT INTO media/i.test(sql)) {
            if (opts.insertThrows) {
                // Genuine DB failure AFTER blob verified — carries internals.
                throw new Error(DB_ERROR_MESSAGE);
            }
            const p = params ?? [];
            const uploadId = p[7] as string;
            if (byUploadId.has(uploadId)) {
                return { rows: [] }; // conflict: inserted nothing
            }
            const row: MediaRow = {
                media_id: nextMediaId++,
                content: p[0] as string,
                type: p[1] as string,
                date: p[2] as string,
                user_id: p[3] as number,
                section_id: p[4] as number,
                event_id: p[5] as number,
                blurhash: (p[6] as string | null) ?? null,
                upload_id: uploadId,
            };
            byUploadId.set(uploadId, row);
            insertedCount++;
            return { rows: [row] };
        }
        if (/SELECT \* FROM media/i.test(sql)) {
            const uploadId = (params ?? [])[0] as string;
            const row = byUploadId.get(uploadId);
            if (opts.integrityDuplicate && row) {
                // Two rows for the same uploadId (integrity violation path).
                return { rows: [row, { ...row, media_id: row.media_id + 1 }] };
            }
            if (opts.conflictThenMissing) {
                // Conflict reported but the row is gone on re-select. Because
                // this branch runs del(), model it as a real removal too.
                byUploadId.delete(uploadId);
                return { rows: [] };
            }
            return { rows: row ? [row] : [] };
        }
        // shapeMediaRow's DTO enrichment SELECT (`... FROM users LEFT JOIN
        //    likes ...`). Added because confirm now returns a Media-DTO-shaped
        //    object (username/likes/liked). Fresh/existing rows have 0 likes /
        //    liked=false; username is a stable stub. Success responses still
        //    carry the SAME media_id as the model row (shapeMediaRow copies it).
        if (/FROM users/i.test(sql)) {
            return { rows: [{ username: 'tester', likes: 0, liked: false }] };
        }
        throw new Error(`Unexpected query in P2 model: ${sql}`);
    }

    return {
        query,
        rowsFor: (uploadId) => {
            const row = byUploadId.get(uploadId);
            return row ? [row] : [];
        },
        totalRows: () => byUploadId.size,
        insertedCount: () => insertedCount,
    };
}

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

function seedRow(uploadId: string): MediaRow {
    return {
        media_id: 4242,
        content: `${BLOB_HOST}/events/${EVENT_ID}/${uploadId}/seed.jpg`,
        type: 'image/jpeg',
        date: '2023-01-01T00:00:00.000Z',
        user_id: 5,
        section_id: SECTION_ID,
        event_id: EVENT_ID,
        blurhash: 'SEED',
        upload_id: uploadId,
    };
}

// --- fast-check generators ----------------------------------------------------

// The confirm-boundary "outcome" scenarios we span.
type Outcome =
    | 'blob-missing' // head throws BlobNotFoundError -> 409
    | 'head-error' // head throws unexpected -> 500
    | 'db-insert-fail' // INSERT throws -> del + 500
    | 'existing-row' // conflict -> SELECT 1 row -> 200
    | 'conflict-missing' // conflict -> SELECT 0 rows -> del + 500
    | 'integrity' // conflict -> SELECT >1 rows -> 500 (no del)
    | 'fresh-insert'; // INSERT returns row -> 201

const outcomeArb: fc.Arbitrary<Outcome> = fc.constantFrom(
    'blob-missing',
    'head-error',
    'db-insert-fail',
    'existing-row',
    'conflict-missing',
    'integrity',
    'fresh-insert',
);

const scenarioArb = fc.record({
    outcome: outcomeArb,
    uploadId: fc.uuid({ version: 4 }),
    contentType: fc.constantFrom(
        'image/jpeg',
        'image/png',
        'image/webp',
        'video/mp4',
        'video/webm',
    ),
    date: fc
        .integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2035, 0, 1) })
        .map((ms) => new Date(ms).toISOString()),
    filename: fc.stringMatching(/^[a-z0-9]{1,12}$/).map((s) => `${s || 'photo'}.jpg`),
    // Repeat count so retries/replays of the same scenario are exercised.
    attempts: fc.integer({ min: 1, max: 4 }),
});

const originalSecret = process.env.JWT_SECRET;

beforeEach(() => {
    process.env.JWT_SECRET = TEST_SECRET;
});

afterEach(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

const NUM_RUNS = 150;

// A response is a "success" iff its status is 200 or 201.
function isSuccess(status: number): boolean {
    return status === 200 || status === 201;
}

describe('P2 — success ⟺ exactly one row; no non-2xx fabricates completion', () => {
    it('every confirm outcome upholds the completion-consistency invariant', async () => {
        await fc.assert(
            fc.asyncProperty(scenarioArb, async (s) => {
                // Configure the model + Blob boundary for THIS outcome. Fresh
                // per run (NOT beforeEach — many cases per `it`).
                const modelOpts: ModelOpts = {};
                if (s.outcome === 'db-insert-fail') modelOpts.insertThrows = true;
                if (s.outcome === 'existing-row') modelOpts.seedExisting = seedRow(s.uploadId);
                if (s.outcome === 'integrity') modelOpts.seedExisting = seedRow(s.uploadId);
                if (s.outcome === 'integrity') modelOpts.integrityDuplicate = true;
                if (s.outcome === 'conflict-missing') modelOpts.seedExisting = seedRow(s.uploadId);
                if (s.outcome === 'conflict-missing') modelOpts.conflictThenMissing = true;

                // The 'conflict-missing' and 'integrity' outcomes are inherently
                // SINGLE-SHOT edge states (a race where the row vanished / a
                // pre-existing duplicate): the confirm route legitimately handles
                // a REPEAT differently (e.g. after 'conflict-missing' cleaned up,
                // a retry validly inserts a fresh row). Repeating them would test
                // a different, valid behaviour rather than the edge itself, so we
                // pin these to a single attempt. All other outcomes still exercise
                // retries/replays via s.attempts.
                const attempts =
                    s.outcome === 'conflict-missing' || s.outcome === 'integrity'
                        ? 1
                        : s.attempts;

                const model = createMediaTableModel(modelOpts);
                dbState.query = model.query;

                headMock.mockReset();
                delMock.mockReset();
                delMock.mockResolvedValue(undefined);
                if (s.outcome === 'blob-missing') {
                    headMock.mockRejectedValue(new FakeBlobNotFoundError());
                } else if (s.outcome === 'head-error') {
                    headMock.mockRejectedValue(
                        new Error('blob head 503: internal at storage-node-7'),
                    );
                } else {
                    headMock.mockResolvedValue({ url: 'ok' });
                }

                const responses: Response[] = [];
                for (let i = 0; i < attempts; i++) {
                    const body = buildConfirmBody(s.uploadId, s.contentType, s.date, s.filename);
                    responses.push(await POST(makeRequest(body), params()));
                }

                // Evaluate the final DB state ONCE after all attempts.
                const finalRows = model.rowsFor(s.uploadId);

                for (const res of responses) {
                    const status = res.status;
                    if (isSuccess(status)) {
                        // SUCCESS => a row exists AND the body's media_id matches it.
                        expect(finalRows.length).toBe(1);
                        const body = (await res.clone().json()) as MediaRow;
                        expect(body.media_id).toBe(finalRows[0].media_id);
                    } else {
                        // NON-2xx => must be a real >=400 status (never a fake success).
                        expect(status).toBeGreaterThanOrEqual(400);
                    }

                    // Server errors (5xx) must NOT leak internals and must carry a
                    // generic message. 4xx client errors also must not leak the DB
                    // internals.
                    if (status >= 500) {
                        const text = await res.clone().text();
                        expect(text).not.toContain('connection refused');
                        expect(text).not.toContain('hunter2');
                        expect(text).not.toContain('password=');
                        expect(text).not.toContain('storage-node-7');
                    }
                }

                // Per-outcome final-state invariants:
                switch (s.outcome) {
                    case 'fresh-insert': {
                        // Exactly one row; at least one 201; no orphan cleanup.
                        expect(finalRows.length).toBe(1);
                        expect(model.insertedCount()).toBe(1);
                        const statuses = responses.map((r) => r.status);
                        expect(statuses.filter((x) => x === 201).length).toBe(1);
                        expect(statuses.every(isSuccess)).toBe(true);
                        expect(delMock).not.toHaveBeenCalled();
                        break;
                    }
                    case 'existing-row': {
                        // Seeded row persists; every response is 200; no insert;
                        // no del.
                        expect(finalRows.length).toBe(1);
                        expect(model.insertedCount()).toBe(0);
                        expect(responses.every((r) => r.status === 200)).toBe(true);
                        expect(delMock).not.toHaveBeenCalled();
                        break;
                    }
                    case 'blob-missing': {
                        // 409 every time; NO row created; no del.
                        expect(responses.every((r) => r.status === 409)).toBe(true);
                        expect(finalRows.length).toBe(0);
                        expect(model.insertedCount()).toBe(0);
                        expect(delMock).not.toHaveBeenCalled();
                        break;
                    }
                    case 'head-error': {
                        // Unexpected head error -> 500; NO row; no del (insert not reached).
                        expect(responses.every((r) => r.status === 500)).toBe(true);
                        expect(finalRows.length).toBe(0);
                        expect(model.insertedCount()).toBe(0);
                        expect(delMock).not.toHaveBeenCalled();
                        break;
                    }
                    case 'db-insert-fail': {
                        // 500 every time; NO row; del attempted (orphan cleanup).
                        expect(responses.every((r) => r.status === 500)).toBe(true);
                        expect(finalRows.length).toBe(0);
                        expect(model.insertedCount()).toBe(0);
                        expect(delMock).toHaveBeenCalled();
                        break;
                    }
                    case 'integrity': {
                        // >1 row seen -> 500; integrity guard NEVER deletes.
                        expect(responses.every((r) => r.status === 500)).toBe(true);
                        expect(delMock).not.toHaveBeenCalled();
                        break;
                    }
                    case 'conflict-missing': {
                        // conflict then 0 rows on re-select -> del + 500; no row.
                        expect(responses.every((r) => r.status === 500)).toBe(true);
                        expect(finalRows.length).toBe(0);
                        expect(delMock).toHaveBeenCalled();
                        break;
                    }
                }
            }),
            { numRuns: NUM_RUNS },
        );
    });

    // CONTROL CASE — prove the harness is not vacuous: a plain fresh insert
    // yields 201 + exactly one row + matching media_id.
    it('CONTROL: a fresh valid confirm returns 201 with exactly one matching row', async () => {
        const model = createMediaTableModel();
        dbState.query = model.query;
        headMock.mockReset();
        delMock.mockReset();
        headMock.mockResolvedValue({ url: 'ok' });
        delMock.mockResolvedValue(undefined);

        const uploadId = '33333333-3333-4333-8333-333333333333';
        const res = await POST(
            makeRequest(buildConfirmBody(uploadId, 'image/jpeg', '2024-01-15T10:30:00.000Z', 'p.jpg')),
            params(),
        );

        expect(res.status).toBe(201);
        const rows = model.rowsFor(uploadId);
        expect(rows.length).toBe(1);
        const body = (await res.json()) as MediaRow;
        expect(body.media_id).toBe(rows[0].media_id);
    });
});
