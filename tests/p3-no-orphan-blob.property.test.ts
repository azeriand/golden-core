// Property test P3 — "No orphaned Blob after a DB failure" — Task 13.6.
//
// Property P3 (design.md P3 "No orphaned Blobs on the happy path" + Req 8.3/21):
//   If the browser upload resolved (the Blob EXISTS at confirm time), then after
//   the confirm route runs, either a matching `media` row exists OR the Blob was
//   deleted after a DB failure — the route never leaves an orphaned Blob and
//   never falsely reports success on a save failure.
//   Validates: Requirements 8.1, 8.2, 8.3, 21.1, 21.4.
//
// Concretely, against the REAL confirm POST handler:
//   1. INSERT returns a row  -> del NOT called, 201, exactly one row.
//   2. INSERT throws (genuine DB failure after the blob was verified to exist)
//      -> del(blobUrl) attempted EXACTLY ONCE with the correct blobUrl,
//         generic 500 "Could not save media", NO row remains.
//   3. del itself rejects (cleanup failure) -> route STILL returns generic 500
//      (does not throw, does not falsely succeed), still no row.
//   Plus: repeated attempts (DB-fail leaves no row; a later success creates
//   exactly one), and the existing-row/conflict case (200, del NOT called).
//
// Boundaries mocked as in confirm.route.test.ts / p1 / p2. The in-memory model
// is a MODEL of the DB (real DB proof is task 13.7); the del spy is the
// observable Blob-cleanup signal.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import jwt from 'jsonwebtoken';
import { NextRequest } from 'next/server';

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

const TEST_SECRET = 'p3-property-test-secret';
const EVENT_ID = 12;
const SECTION_ID = 99;
const EVENT_SLUG = 'my-event';
const NORMAL_EMAIL = 'user@example.test';
const BLOB_HOST = 'https://blob.example.com';
const DB_ERROR_MESSAGE = 'db exploded: fatal at pg-node password=s3cr3t';

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

interface MediaTableModel {
    query: (sql: string, params?: unknown[]) => Promise<unknown>;
    rowsFor: (uploadId: string) => MediaRow[];
    insertedCount: () => number;
    setInsertThrows: (v: boolean) => void;
    seed: (row: MediaRow) => void;
}

function createMediaTableModel(): MediaTableModel {
    const byUploadId = new Map<string, MediaRow>();
    let nextMediaId = 7000;
    let insertedCount = 0;
    let insertThrows = false;

    async function query(sql: string, params?: unknown[]): Promise<unknown> {
        if (/FROM events/i.test(sql)) return { rows: [{ event_id: EVENT_ID }] };
        if (/FROM sections/i.test(sql)) return { rows: [{ section_id: SECTION_ID }] };
        if (/INSERT INTO media/i.test(sql)) {
            if (insertThrows) throw new Error(DB_ERROR_MESSAGE);
            const p = params ?? [];
            const uploadId = p[7] as string;
            if (byUploadId.has(uploadId)) return { rows: [] };
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
            return { rows: row ? [row] : [] };
        }
        // shapeMediaRow's DTO enrichment SELECT (`... FROM users LEFT JOIN
        //    likes ...`). Added because confirm now returns a Media-DTO-shaped
        //    object (username/likes/liked). Only reached on the success paths
        //    (201/200); the DB-fail branch never gets here.
        if (/FROM users/i.test(sql)) {
            return { rows: [{ username: 'tester', likes: 0, liked: false }] };
        }
        throw new Error(`Unexpected query in P3 model: ${sql}`);
    }

    return {
        query,
        rowsFor: (uploadId) => {
            const row = byUploadId.get(uploadId);
            return row ? [row] : [];
        },
        insertedCount: () => insertedCount,
        setInsertThrows: (v) => {
            insertThrows = v;
        },
        seed: (row) => {
            byUploadId.set(row.upload_id, { ...row });
        },
    };
}

function blobUrlFor(uploadId: string, filename: string): string {
    return `${BLOB_HOST}/events/${EVENT_ID}/${uploadId}/${filename}`;
}

function buildConfirmBody(
    uploadId: string,
    contentType: string,
    date: string,
    filename: string,
): Record<string, unknown> {
    return {
        uploadId,
        blobUrl: blobUrlFor(uploadId, filename),
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

const baseArb = fc.record({
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

function freshBoundary(): void {
    headMock.mockReset();
    delMock.mockReset();
    headMock.mockResolvedValue({ url: 'ok' }); // blob EXISTS for P3
    delMock.mockResolvedValue(undefined);
}

describe('P3 — no orphaned Blob after a DB failure', () => {
    // (1) Successful persistence: del NOT called, 201, one row.
    it('successful DB persistence never deletes the Blob (201, one row, no del)', async () => {
        await fc.assert(
            fc.asyncProperty(baseArb, async (s) => {
                const model = createMediaTableModel();
                dbState.query = model.query;
                freshBoundary();

                const res = await POST(
                    makeRequest(buildConfirmBody(s.uploadId, s.contentType, s.date, s.filename)),
                    params(),
                );

                expect(res.status).toBe(201);
                expect(model.rowsFor(s.uploadId).length).toBe(1);
                expect(delMock).not.toHaveBeenCalled();
            }),
            { numRuns: NUM_RUNS },
        );
    });

    // (2) Genuine DB failure after blob verification -> del once + 500 + no row.
    it('DB insert failure deletes the Blob exactly once and leaves no row (generic 500)', async () => {
        await fc.assert(
            fc.asyncProperty(baseArb, async (s) => {
                const model = createMediaTableModel();
                model.setInsertThrows(true);
                dbState.query = model.query;
                freshBoundary();

                const blobUrl = blobUrlFor(s.uploadId, s.filename);
                const res = await POST(
                    makeRequest(buildConfirmBody(s.uploadId, s.contentType, s.date, s.filename)),
                    params(),
                );

                expect(res.status).toBe(500);
                // del attempted exactly once with the correct blobUrl.
                expect(delMock).toHaveBeenCalledTimes(1);
                expect(delMock.mock.calls[0][0]).toBe(blobUrl);
                // No row remains.
                expect(model.rowsFor(s.uploadId).length).toBe(0);
                // Generic message, no internals leaked.
                const text = await res.text();
                expect(text).toContain('Could not save media');
                expect(text).not.toContain('connection refused');
                expect(text).not.toContain('s3cr3t');
                expect(text).not.toContain('password=');
            }),
            { numRuns: NUM_RUNS },
        );
    });

    // (3) Cleanup failure: del rejects -> STILL a generic 500, still no row.
    it('when del rejects, the route still returns a generic 500 (no throw, no false success)', async () => {
        await fc.assert(
            fc.asyncProperty(baseArb, async (s) => {
                const model = createMediaTableModel();
                model.setInsertThrows(true);
                dbState.query = model.query;
                headMock.mockReset();
                delMock.mockReset();
                headMock.mockResolvedValue({ url: 'ok' });
                // Cleanup fails — the .catch wrapper must swallow this and STILL 500.
                delMock.mockRejectedValue(new Error('del failed: blob store 500'));

                const res = await POST(
                    makeRequest(buildConfirmBody(s.uploadId, s.contentType, s.date, s.filename)),
                    params(),
                );

                expect(res.status).toBe(500);
                expect(delMock).toHaveBeenCalledTimes(1);
                expect(model.rowsFor(s.uploadId).length).toBe(0);
                const text = await res.text();
                expect(text).toContain('Could not save media');
                // The cleanup-failure internals must not leak either.
                expect(text).not.toContain('blob store 500');
            }),
            { numRuns: NUM_RUNS },
        );
    });

    // (4) Repeated attempts: DB-fail leaves no row; a later success creates one.
    it('DB-fail then success: no row after the failure, exactly one row after success', async () => {
        await fc.assert(
            fc.asyncProperty(baseArb, async (s) => {
                const model = createMediaTableModel();
                dbState.query = model.query;
                freshBoundary();

                // First attempt fails at the DB.
                model.setInsertThrows(true);
                const failRes = await POST(
                    makeRequest(buildConfirmBody(s.uploadId, s.contentType, s.date, s.filename)),
                    params(),
                );
                expect(failRes.status).toBe(500);
                expect(model.rowsFor(s.uploadId).length).toBe(0);
                expect(delMock).toHaveBeenCalledTimes(1);

                // Retry (same uploadId) now succeeds.
                model.setInsertThrows(false);
                delMock.mockClear();
                const okRes = await POST(
                    makeRequest(buildConfirmBody(s.uploadId, s.contentType, s.date, s.filename)),
                    params(),
                );
                expect(okRes.status).toBe(201);
                expect(model.rowsFor(s.uploadId).length).toBe(1);
                // No del on the successful attempt.
                expect(delMock).not.toHaveBeenCalled();
            }),
            { numRuns: NUM_RUNS },
        );
    });

    // (5) Existing-row / conflict case: 200 and del NOT called.
    it('conflict (existing row) returns 200 and never deletes the Blob', async () => {
        await fc.assert(
            fc.asyncProperty(baseArb, async (s) => {
                const model = createMediaTableModel();
                model.seed({
                    media_id: 999,
                    content: blobUrlFor(s.uploadId, s.filename),
                    type: s.contentType,
                    date: s.date,
                    user_id: 5,
                    section_id: SECTION_ID,
                    event_id: EVENT_ID,
                    blurhash: null,
                    upload_id: s.uploadId,
                });
                dbState.query = model.query;
                freshBoundary();

                const res = await POST(
                    makeRequest(buildConfirmBody(s.uploadId, s.contentType, s.date, s.filename)),
                    params(),
                );

                expect(res.status).toBe(200);
                expect(model.rowsFor(s.uploadId).length).toBe(1);
                expect(model.insertedCount()).toBe(0);
                expect(delMock).not.toHaveBeenCalled();
            }),
            { numRuns: NUM_RUNS },
        );
    });
});
