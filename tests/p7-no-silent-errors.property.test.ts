// Property test P7 — "No silent errors" — Task 13.6.
//
// Property P7 (design.md / tasks.md):
//   Every failure path SURFACES the failure (a non-2xx status / an explicit
//   error return / an APPROVED graceful no-op) and NEVER silently becomes a
//   SUCCESS or a fabricated completed row.
//   Validates: Requirements 18.1, 18.2, 18.3, and the P7 correctness property.
//
// This file exercises the boundaries the implementation actually has:
//   (A) CONFIRM route boundary failures — for ANY injected failure at a confirm
//       boundary the outcome is a surfaced NON-2xx AND the DB model shows NO
//       fabricated completed row for that uploadId AND (server 5xx) the body is
//       the generic message with no internals.
//   (B) PREPROCESS boundary — decode/encode failure => processed:false with the
//       ORIGINAL file (APPROVED graceful no-op; not a throw and not a bogus
//       transformed success).
//   (C) RECONCILIATION (onUploadCompleted) via the handleUpload fake — an
//       injected transient DB error causes the handler to THROW (so Blob
//       retries) rather than silently succeed; expected no-ops (forged
//       context / blob missing) create NO row.
//
// IMPORTANT (per the brief): server-side console.error on 500 paths is PERMITTED
// (Req 18.4 allows server-side logging). We do NOT assert "no console.error".
// We DO spy on console.error to CONFIRM a server error was logged on 5xx paths
// (evidence the error was surfaced, not swallowed), but never fail merely
// because it was called.
//
// Boundaries mocked as in confirm.route.test.ts / p1 / p4. The in-memory model
// is a MODEL of the DB (real DB proof is task 13.7).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import jwt from 'jsonwebtoken';
import { NextRequest } from 'next/server';

const { dbState, headMock, delMock, handleUploadState, FakeBlobNotFoundError } =
    vi.hoisted(() => {
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
        const handleUploadState: { impl: (args: unknown) => Promise<unknown> } = {
            impl: async () => {
                throw new Error('handleUpload mock not initialised');
            },
        };
        return {
            dbState,
            headMock: vi.fn(),
            delMock: vi.fn(),
            handleUploadState,
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

vi.mock('@vercel/blob/client', () => ({
    handleUpload: (args: unknown) => handleUploadState.impl(args),
}));

import { POST as confirmPOST } from '@/app/api/event/[event-slug]/media/confirm/route';
import { POST as uploadTokenPOST } from '@/app/api/event/[event-slug]/media/upload-token/route';
import { preprocessImage } from '@/lib/image-preprocess';

// --- Fixtures ----------------------------------------------------------------

const TEST_SECRET = 'p7-property-test-secret';
const EVENT_ID = 12;
const SECTION_ID = 99;
const EVENT_SLUG = 'my-event';
const NORMAL_EMAIL = 'user@example.test';
const BLOB_HOST = 'https://blob.example.com';
const DB_ERROR_MESSAGE = 'db exploded: connection refused at 10.0.0.1 password=hunter2';
const HEAD_ERROR_MESSAGE = 'blob head 503: internal at storage-node-7';

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

interface ModelOpts {
    insertThrows?: boolean;
    eventMissing?: boolean;
}

interface MediaTableModel {
    query: (sql: string, params?: unknown[]) => Promise<unknown>;
    rowsFor: (uploadId: string) => MediaRow[];
    insertAttempts: () => number;
    totalRows: () => number;
}

function createMediaTableModel(opts: ModelOpts = {}): MediaTableModel {
    const byUploadId = new Map<string, MediaRow>();
    let nextMediaId = 8000;
    let insertAttempts = 0;

    async function query(sql: string, params?: unknown[]): Promise<unknown> {
        if (/FROM events/i.test(sql)) {
            return { rows: opts.eventMissing ? [] : [{ event_id: EVENT_ID }] };
        }
        if (/FROM sections/i.test(sql)) return { rows: [{ section_id: SECTION_ID }] };
        if (/INSERT INTO media/i.test(sql)) {
            insertAttempts++;
            if (opts.insertThrows) throw new Error(DB_ERROR_MESSAGE);
            const p = params ?? [];
            const uploadId = p[7] as string;
            if (byUploadId.has(uploadId)) return { rows: [], rowCount: 0 };
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
            return { rows: [row], rowCount: 1 };
        }
        if (/SELECT \* FROM media/i.test(sql)) {
            const uploadId = (params ?? [])[0] as string;
            const row = byUploadId.get(uploadId);
            return { rows: row ? [row] : [] };
        }
        throw new Error(`Unexpected query in P7 model: ${sql}`);
    }

    return {
        query,
        rowsFor: (uploadId) => {
            const row = byUploadId.get(uploadId);
            return row ? [row] : [];
        },
        insertAttempts: () => insertAttempts,
        totalRows: () => byUploadId.size,
    };
}

function makeRequest(body: unknown): NextRequest {
    const req = new NextRequest('https://example.test/api/confirm', {
        method: 'POST',
        body: typeof body === 'string' ? body : JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
    });
    req.cookies.set('auth_token', signToken(NORMAL_EMAIL));
    return req;
}

function params(slug = EVENT_SLUG): { params: Promise<{ 'event-slug': string }> } {
    return { params: Promise.resolve({ 'event-slug': slug }) };
}

function goodBlobUrl(uploadId: string, filename: string): string {
    return `${BLOB_HOST}/events/${EVENT_ID}/${uploadId}/${filename}`;
}

function validConfirmBody(uploadId: string, filename = 'photo.jpg'): Record<string, unknown> {
    return {
        uploadId,
        blobUrl: goodBlobUrl(uploadId, filename),
        filename,
        contentType: 'image/jpeg',
        originalSize: 2_000_000,
        processedSize: 400_000,
        date: '2024-01-15T10:30:00.000Z',
        blurhash: 'LEHV6nWB2yk8',
    };
}

const originalSecret = process.env.JWT_SECRET;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    process.env.JWT_SECRET = TEST_SECRET;
    // Silence + observe server-side logging (permitted on 5xx paths, Req 18.4).
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
    vi.restoreAllMocks();
});

const NUM_RUNS = 150;

// --- (A) CONFIRM boundary failures -------------------------------------------

// Each failure kind describes: how to build the body / configure the model +
// Blob boundary, the expected status, and whether it is a server (5xx) error.
type ConfirmFailure =
    | 'malformed-body' // 400
    | 'invalid-uploadId' // 400
    | 'event-not-found' // 404
    | 'blob-event-mismatch' // 400
    | 'head-blob-not-found' // 409
    | 'head-unexpected' // 500
    | 'db-insert-throw'; // 500 + del

const confirmFailureArb: fc.Arbitrary<ConfirmFailure> = fc.constantFrom(
    'malformed-body',
    'invalid-uploadId',
    'event-not-found',
    'blob-event-mismatch',
    'head-blob-not-found',
    'head-unexpected',
    'db-insert-throw',
);

const confirmScenarioArb = fc.record({
    failure: confirmFailureArb,
    uploadId: fc.uuid({ version: 4 }),
    filename: fc.stringMatching(/^[a-z0-9]{1,12}$/).map((s) => `${s || 'photo'}.jpg`),
    // For blob-event-mismatch: a wrong event id in the blob url.
    wrongEventId: fc.integer({ min: 100, max: 9999 }),
});

describe('P7 — confirm boundary failures are always surfaced, never a false success', () => {
    it('for any injected confirm-boundary failure: non-2xx, no fabricated row, no leaked internals', async () => {
        await fc.assert(
            fc.asyncProperty(confirmScenarioArb, async (s) => {
                const model = createMediaTableModel({
                    insertThrows: s.failure === 'db-insert-throw',
                    eventMissing: s.failure === 'event-not-found',
                });
                dbState.query = model.query;

                headMock.mockReset();
                delMock.mockReset();
                delMock.mockResolvedValue(undefined);
                if (s.failure === 'head-blob-not-found') {
                    headMock.mockRejectedValue(new FakeBlobNotFoundError());
                } else if (s.failure === 'head-unexpected') {
                    headMock.mockRejectedValue(new Error(HEAD_ERROR_MESSAGE));
                } else {
                    headMock.mockResolvedValue({ url: 'ok' });
                }

                // Build the request body per failure kind.
                let requestBody: unknown;
                if (s.failure === 'malformed-body') {
                    requestBody = '{not valid json';
                } else if (s.failure === 'invalid-uploadId') {
                    requestBody = { ...validConfirmBody(s.uploadId, s.filename), uploadId: 'not-a-uuid' };
                } else if (s.failure === 'blob-event-mismatch') {
                    requestBody = {
                        ...validConfirmBody(s.uploadId, s.filename),
                        blobUrl: `${BLOB_HOST}/events/${s.wrongEventId}/${s.uploadId}/${s.filename}`,
                    };
                } else {
                    requestBody = validConfirmBody(s.uploadId, s.filename);
                }

                const res = await confirmPOST(makeRequest(requestBody), params());

                // (i) Surfaced as a real non-2xx.
                expect(res.status).toBeGreaterThanOrEqual(400);

                // (ii) Expected status per failure kind.
                const expectedStatus: Record<ConfirmFailure, number> = {
                    'malformed-body': 400,
                    'invalid-uploadId': 400,
                    'event-not-found': 404,
                    'blob-event-mismatch': 400,
                    'head-blob-not-found': 409,
                    'head-unexpected': 500,
                    'db-insert-throw': 500,
                };
                expect(res.status).toBe(expectedStatus[s.failure]);

                // (iii) No fabricated completed row for this uploadId.
                expect(model.rowsFor(s.uploadId).length).toBe(0);

                // (iv) Server 5xx: generic message, no internals leaked, AND a
                //      server-side log confirms it was surfaced (not swallowed).
                if (res.status >= 500) {
                    const text = await res.clone().text();
                    expect(text).not.toContain('connection refused');
                    expect(text).not.toContain('hunter2');
                    expect(text).not.toContain('password=');
                    expect(text).not.toContain('storage-node-7');
                    expect(consoleErrorSpy).toHaveBeenCalled();
                }
            }),
            { numRuns: NUM_RUNS },
        );
    });
});

// --- (B) PREPROCESS failure boundary -----------------------------------------

// Reuse the standard browser-boundary fake, injecting decode/encode failure.
interface PpControls {
    reject: boolean;
    throwConvert: boolean;
    nullConvert: boolean;
}
let ppControls: PpControls;

function installPreprocessStubs(): void {
    const createImageBitmapMock = vi.fn(async () => {
        if (ppControls.reject) throw new Error('decode failed (injected)');
        return { width: 4000, height: 3000, close: vi.fn() };
    });
    const convertToBlobMock = vi.fn(async (opts: { type: string; quality: number }) => {
        if (ppControls.throwConvert) throw new Error('encode failed (injected)');
        if (ppControls.nullConvert) return null;
        return new Blob([new Uint8Array(100)], { type: opts.type });
    });
    class FakeOffscreenCanvas {
        width: number;
        height: number;
        constructor(w: number, h: number) {
            this.width = w;
            this.height = h;
        }
        getContext(kind: string) {
            if (kind !== '2d') return null;
            return { drawImage: () => {} };
        }
        convertToBlob(opts: { type: string; quality: number }) {
            return convertToBlobMock(opts);
        }
    }
    vi.stubGlobal('createImageBitmap', createImageBitmapMock);
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    vi.stubGlobal('document', undefined);
}

describe('P7 — preprocess failure is an approved graceful no-op, never a bogus success', () => {
    it('decode/encode failure returns processed:false with the ORIGINAL file (no throw)', async () => {
        const arb = fc.record({
            mime: fc.constantFrom('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/gif'),
            mode: fc.constantFrom('reject', 'throw', 'null'),
        });

        await fc.assert(
            fc.asyncProperty(arb, async (c) => {
                ppControls = {
                    reject: c.mode === 'reject',
                    throwConvert: c.mode === 'throw',
                    nullConvert: c.mode === 'null',
                };
                installPreprocessStubs();

                const input = new File([new Uint8Array(2_000_000)], 'photo', { type: c.mime });

                // Must NOT throw — a throw would be an unsurfaced/unhandled error.
                const result = await preprocessImage(input, { minSkipBytes: 0 });

                // Approved graceful no-op: processed:false, original returned.
                expect(result.processed).toBe(false);
                expect(result.blob).toBe(input);

                vi.unstubAllGlobals();
            }),
            { numRuns: NUM_RUNS },
        );
    });
});

// --- (C) RECONCILIATION (onUploadCompleted) surfacing ------------------------

describe('P7 — reconciliation surfaces transient DB errors and never silently succeeds', () => {
    it('injected transient DB error in onUploadCompleted THROWS (Blob retries), no row', async () => {
        const arb = fc.record({
            uploadId: fc.uuid({ version: 4 }),
            date: fc
                .integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2035, 0, 1) })
                .map((ms) => new Date(ms).toISOString()),
        });

        await fc.assert(
            fc.asyncProperty(arb, async (s) => {
                // Model whose INSERT throws a transient error -> the handler must
                // rethrow so Blob retries (not swallow into a silent success).
                const model = createMediaTableModel({ insertThrows: true });
                dbState.query = model.query;
                headMock.mockReset();
                delMock.mockReset();
                headMock.mockResolvedValue({ url: 'ok' });

                // Capture the route's real onUploadCompleted via the SDK fake.
                let captured:
                    | ((e: { blob: unknown; tokenPayload?: string | null }) => Promise<unknown>)
                    | null = null;
                handleUploadState.impl = async (args: unknown) => {
                    const a = args as {
                        onUploadCompleted: (e: {
                            blob: unknown;
                            tokenPayload?: string | null;
                        }) => Promise<unknown>;
                    };
                    captured = a.onUploadCompleted;
                    return { type: 'blob.upload-completed', response: 'ok' };
                };

                // Drive with a NON-demo slug + user so handleUpload runs and the
                // callback is captured.
                const body = {
                    type: 'blob.generate-client-token',
                    payload: {
                        pathname: `events/${EVENT_ID}/${s.uploadId}/photo.jpg`,
                        callbackUrl: 'https://example.test/api/upload-token',
                        clientPayload: JSON.stringify({
                            uploadId: s.uploadId,
                            eventSlug: EVENT_SLUG,
                            filename: 'photo.jpg',
                            contentType: 'image/jpeg',
                            size: 2_000_000,
                            date: s.date,
                        }),
                        multipart: false,
                    },
                };
                await uploadTokenPOST(makeRequest(body), params(EVENT_SLUG));

                expect(typeof captured).toBe('function');
                const onCompleted = captured as unknown as (e: {
                    blob: unknown;
                    tokenPayload?: string | null;
                }) => Promise<unknown>;

                // A VALID reconciliation context (event resolves + eventId matches
                // + pathname belongs + blob exists) so the INSERT is REACHED and
                // the injected transient DB error causes a THROW.
                await expect(
                    onCompleted({
                        blob: {
                            url: goodBlobUrl(s.uploadId, 'photo.jpg'),
                            pathname: `events/${EVENT_ID}/${s.uploadId}/photo.jpg`,
                            contentType: 'image/jpeg',
                        },
                        tokenPayload: JSON.stringify({
                            uploadId: s.uploadId,
                            userId: 5,
                            eventId: EVENT_ID,
                            date: s.date,
                        }),
                    }),
                ).rejects.toThrow();

                // The insert was attempted (error surfaced), and no row survived.
                expect(model.insertAttempts()).toBeGreaterThanOrEqual(1);
                expect(model.rowsFor(s.uploadId).length).toBe(0);
            }),
            { numRuns: NUM_RUNS },
        );
    });

    it('expected reconciliation no-ops (forged eventId / blob missing) create no row and do not throw', async () => {
        const arb = fc.record({
            uploadId: fc.uuid({ version: 4 }),
            date: fc
                .integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2035, 0, 1) })
                .map((ms) => new Date(ms).toISOString()),
            kind: fc.constantFrom('forged-eventid', 'blob-missing'),
        });

        await fc.assert(
            fc.asyncProperty(arb, async (s) => {
                const model = createMediaTableModel();
                dbState.query = model.query;
                headMock.mockReset();
                delMock.mockReset();
                if (s.kind === 'blob-missing') {
                    headMock.mockRejectedValue(new FakeBlobNotFoundError());
                } else {
                    headMock.mockResolvedValue({ url: 'ok' });
                }

                let captured:
                    | ((e: { blob: unknown; tokenPayload?: string | null }) => Promise<unknown>)
                    | null = null;
                handleUploadState.impl = async (args: unknown) => {
                    const a = args as {
                        onUploadCompleted: (e: {
                            blob: unknown;
                            tokenPayload?: string | null;
                        }) => Promise<unknown>;
                    };
                    captured = a.onUploadCompleted;
                    return { type: 'blob.upload-completed', response: 'ok' };
                };

                const body = {
                    type: 'blob.generate-client-token',
                    payload: {
                        pathname: `events/${EVENT_ID}/${s.uploadId}/photo.jpg`,
                        callbackUrl: 'https://example.test/api/upload-token',
                        clientPayload: JSON.stringify({
                            uploadId: s.uploadId,
                            eventSlug: EVENT_SLUG,
                            filename: 'photo.jpg',
                            contentType: 'image/jpeg',
                            size: 2_000_000,
                            date: s.date,
                        }),
                        multipart: false,
                    },
                };
                await uploadTokenPOST(makeRequest(body), params(EVENT_SLUG));

                expect(typeof captured).toBe('function');
                const onCompleted = captured as unknown as (e: {
                    blob: unknown;
                    tokenPayload?: string | null;
                }) => Promise<unknown>;

                // forged-eventid: tokenPayload eventId != resolved event -> no row.
                // blob-missing: head reports not found -> no row.
                const forgedEventId = s.kind === 'forged-eventid' ? EVENT_ID + 500 : EVENT_ID;
                const pathPrefixEventId = forgedEventId;

                // Expected no-op: must NOT throw and must create no row.
                await expect(
                    onCompleted({
                        blob: {
                            url: `${BLOB_HOST}/events/${pathPrefixEventId}/${s.uploadId}/photo.jpg`,
                            pathname: `events/${pathPrefixEventId}/${s.uploadId}/photo.jpg`,
                            contentType: 'image/jpeg',
                        },
                        tokenPayload: JSON.stringify({
                            uploadId: s.uploadId,
                            userId: 5,
                            eventId: forgedEventId,
                            date: s.date,
                        }),
                    }),
                ).resolves.not.toThrow();

                expect(model.rowsFor(s.uploadId).length).toBe(0);
            }),
            { numRuns: NUM_RUNS },
        );
    });
});
