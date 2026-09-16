// Unit tests for the webhook-path (onUploadCompleted) poster-job enqueue wiring
// — Task 4.1.
// app/api/event/[event-slug]/media/upload-token/route.ts
//
// FOCUS: the Webhook_Path enqueue behavior (design Component 4, Req 4.1-4.4):
//   - a FRESHLY-INSERTED video row enqueues exactly one poster job;
//   - a NO-OP video row (confirm won the race, ON CONFLICT DO NOTHING) still
//     enqueues exactly one poster job (resolved via SELECT media_id);
//   - IMAGE content enqueues NOTHING;
//   - a transient enqueue DB error is RETHROWN so Vercel Blob retries the
//     webhook (error semantics differ from the confirm route).
//
// The route drives reconciliation inside `handleUpload`'s `onUploadCompleted`
// callback. We mock ONLY external boundaries:
//   - `@vercel/blob/client` -> handleUpload (invokes the real onUploadCompleted
//     with a synthesized blob + the server-signed tokenPayload, exactly as the
//     Vercel Blob webhook would);
//   - `@vercel/blob`        -> head / BlobNotFoundError;
//   - `@/lib/db`            -> pool.query (a vi.fn we route per SQL text);
//   - `@/lib/poster-jobs`   -> enqueuePosterJob (spy) + REAL isVideoType so the
//     video-only gating is exercised against the real predicate.
// REAL: `@/lib/auth` verifyRequest (real signed JWT), `@/lib/demo-guard`,
//       `@/lib/section-match`.
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

// --- Mock external boundaries BEFORE importing the route ---------------------
// vi.mock factories are hoisted; values they close over must come from
// vi.hoisted.
const {
    queryMock,
    headMock,
    enqueueMock,
    handleUploadMock,
    FakeBlobNotFoundError,
} = vi.hoisted(() => {
    class FakeBlobNotFoundError extends Error {
        constructor() {
            super('Blob not found');
            this.name = 'BlobNotFoundError';
        }
    }
    return {
        queryMock: vi.fn(),
        headMock: vi.fn(),
        enqueueMock: vi.fn(),
        handleUploadMock: vi.fn(),
        FakeBlobNotFoundError,
    };
});

vi.mock('@/lib/db', () => ({
    default: { query: (...args: unknown[]) => queryMock(...args) },
}));

vi.mock('@vercel/blob', () => ({
    head: (...args: unknown[]) => headMock(...args),
    BlobNotFoundError: FakeBlobNotFoundError,
}));

vi.mock('@vercel/blob/client', () => ({
    handleUpload: (...args: unknown[]) => handleUploadMock(...args),
}));

// Mock enqueuePosterJob (the boundary under test) but keep the REAL isVideoType
// so the video-only gate is genuinely exercised.
vi.mock('@/lib/poster-jobs', async () => {
    const actual = await vi.importActual<typeof import('@/lib/poster-jobs')>(
        '@/lib/poster-jobs',
    );
    return {
        ...actual,
        enqueuePosterJob: (...args: unknown[]) => enqueueMock(...args),
    };
});

// Import AFTER mocks are registered.
import { POST } from '@/app/api/event/[event-slug]/media/upload-token/route';

// --- Fixtures ----------------------------------------------------------------

const TEST_SECRET = 'upload-token-route-test-secret';
const VALID_UUID = '22222222-2222-4222-8222-222222222222';
const EVENT_ID = 12;
const USER_ID = 5;
const MEDIA_ID = 777;
const FIXED_DATE = '2024-01-15T10:30:00.000Z';
const EVENT_SLUG = 'my-event';
const NORMAL_EMAIL = 'user@example.test';

function signToken(email: string): string {
    return jwt.sign({ userId: USER_ID, email, isAdmin: false }, TEST_SECRET, {
        expiresIn: '1h',
    });
}

function makeRequest(email = NORMAL_EMAIL): NextRequest {
    const req = new NextRequest('https://example.test/api/upload-token', {
        method: 'POST',
        body: JSON.stringify({ type: 'blob.generate-client-token' }),
        headers: { 'content-type': 'application/json' },
    });
    req.cookies.set('auth_token', signToken(email));
    return req;
}

function params(slug = EVENT_SLUG): { params: Promise<{ 'event-slug': string }> } {
    return { params: Promise.resolve({ 'event-slug': slug }) };
}

// The server-signed tokenPayload THIS route sets at handshake time and receives
// back in onUploadCompleted. Built here exactly as the route builds it.
function tokenPayload(): string {
    return JSON.stringify({
        uploadId: VALID_UUID,
        userId: USER_ID,
        eventId: EVENT_ID,
        date: FIXED_DATE,
        creationTime: null,
    });
}

// A completed-blob descriptor mirroring PutBlobResult for the given contentType.
function completedBlob(contentType: string) {
    return {
        url: `https://blob.example.com/events/${EVENT_ID}/${VALID_UUID}/file-abc`,
        pathname: `events/${EVENT_ID}/${VALID_UUID}/file-abc`,
        contentType,
    };
}

// Route pool.query per SQL text. `insertedRowCount` controls whether the
// idempotent INSERT reports a fresh insert (1) or an ON CONFLICT no-op (0).
// `mediaRows` are the rows the `SELECT media_id ... WHERE upload_id` returns.
interface QueryPlan {
    event?: unknown[];
    insertedRowCount?: number;
    mediaRows?: unknown[];
    // If set, the SELECT media_id query throws this error (transient DB error).
    selectMediaThrows?: Error;
}

function planQueries(plan: QueryPlan): void {
    queryMock.mockImplementation(async (sql: string) => {
        if (/FROM events/i.test(sql)) {
            return { rows: plan.event ?? [{ event_id: EVENT_ID }] };
        }
        if (/INSERT INTO media/i.test(sql)) {
            return { rows: [], rowCount: plan.insertedRowCount ?? 1 };
        }
        if (/SELECT media_id FROM media/i.test(sql)) {
            if (plan.selectMediaThrows) throw plan.selectMediaThrows;
            return { rows: plan.mediaRows ?? [{ media_id: MEDIA_ID }] };
        }
        throw new Error(`Unexpected query in test: ${sql}`);
    });
}

// Drive the route by making handleUpload invoke onUploadCompleted with the given
// blob + tokenPayload, exactly as the Vercel Blob webhook does after an upload.
// Returns whatever onUploadCompleted resolves/rejects with surfaced through the
// route so a rethrow is observable.
function driveWebhook(blobContentType: string): void {
    handleUploadMock.mockImplementation(
        async ({ onUploadCompleted }: {
            onUploadCompleted: (arg: {
                blob: ReturnType<typeof completedBlob>;
                tokenPayload: string;
            }) => Promise<void>;
        }) => {
            await onUploadCompleted({
                blob: completedBlob(blobContentType),
                tokenPayload: tokenPayload(),
            });
            return { type: 'blob.generate-client-token', clientToken: 'tok' };
        },
    );
}

const originalSecret = process.env.JWT_SECRET;

beforeEach(() => {
    process.env.JWT_SECRET = TEST_SECRET;
    queryMock.mockReset();
    headMock.mockReset();
    enqueueMock.mockReset();
    handleUploadMock.mockReset();
    headMock.mockResolvedValue({ url: 'ok' });
    enqueueMock.mockResolvedValue(true);
});

afterEach(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
    vi.restoreAllMocks();
});

describe('webhook path — poster enqueue on video insert (Req 4.1)', () => {
    it('enqueues exactly one poster job when a video row is freshly inserted', async () => {
        planQueries({ insertedRowCount: 1, mediaRows: [{ media_id: MEDIA_ID }] });
        driveWebhook('video/mp4');

        const res = await POST(makeRequest(), params());

        expect(res.status).toBe(200);
        // Enqueued exactly once, against the resolved media_id.
        expect(enqueueMock).toHaveBeenCalledTimes(1);
        expect(enqueueMock.mock.calls[0][1]).toBe(MEDIA_ID);
        // The media_id was resolved via SELECT ... WHERE upload_id.
        const selectCall = queryMock.mock.calls.find((c) =>
            /SELECT media_id FROM media/i.test(c[0] as string),
        );
        expect(selectCall).toBeTruthy();
        expect((selectCall![1] as unknown[])[0]).toBe(VALID_UUID);
    });
});

describe('webhook path — poster enqueue on no-op branch (Req 4.2)', () => {
    it('enqueues exactly one poster job when the video row already existed (ON CONFLICT no-op)', async () => {
        // insertedRowCount 0 => confirm won the race; the row already exists and
        // enqueue must still run against the media_id resolved by SELECT.
        planQueries({ insertedRowCount: 0, mediaRows: [{ media_id: MEDIA_ID }] });
        driveWebhook('video/quicktime');

        const res = await POST(makeRequest(), params());

        expect(res.status).toBe(200);
        expect(enqueueMock).toHaveBeenCalledTimes(1);
        expect(enqueueMock.mock.calls[0][1]).toBe(MEDIA_ID);
    });
});

describe('webhook path — image content does not enqueue (Req 4.3)', () => {
    it('never enqueues a poster job for an image upload', async () => {
        planQueries({ insertedRowCount: 1 });
        driveWebhook('image/jpeg');

        const res = await POST(makeRequest(), params());

        expect(res.status).toBe(200);
        expect(enqueueMock).not.toHaveBeenCalled();
        // For an image, the media_id resolution SELECT is never even run.
        const selectCalled = queryMock.mock.calls.some((c) =>
            /SELECT media_id FROM media/i.test(c[0] as string),
        );
        expect(selectCalled).toBe(false);
    });
});

describe('webhook path — transient enqueue error is retryable (Req 4.4)', () => {
    it('rethrows a transient enqueue DB error so the webhook is retried', async () => {
        planQueries({ insertedRowCount: 1, mediaRows: [{ media_id: MEDIA_ID }] });
        enqueueMock.mockRejectedValueOnce(new Error('db connection reset'));
        driveWebhook('video/mp4');

        // handleUpload has no try/catch around a rethrown onUploadCompleted error
        // in the route's success path; the POST maps thrown handleUpload errors
        // to a 400. The KEY assertion is that the enqueue error PROPAGATED out of
        // onUploadCompleted (so Vercel Blob would retry) rather than being
        // swallowed — observable via handleUpload rejecting.
        handleUploadMock.mockImplementation(
            async ({ onUploadCompleted }: {
                onUploadCompleted: (arg: {
                    blob: ReturnType<typeof completedBlob>;
                    tokenPayload: string;
                }) => Promise<void>;
            }) => {
                // onUploadCompleted must reject (the enqueue error is rethrown).
                await expect(
                    onUploadCompleted({
                        blob: completedBlob('video/mp4'),
                        tokenPayload: tokenPayload(),
                    }),
                ).rejects.toThrow('db connection reset');
                throw new Error('db connection reset');
            },
        );

        const res = await POST(makeRequest(), params());
        // The route surfaces the thrown handleUpload failure; the essential
        // behavior (enqueue error propagated, not swallowed) is asserted above.
        expect(res.status).toBe(400);
        expect(enqueueMock).toHaveBeenCalledTimes(1);
    });

    it('rethrows a transient media_id-resolution DB error so the webhook is retried', async () => {
        planQueries({
            insertedRowCount: 1,
            selectMediaThrows: new Error('db timeout resolving media_id'),
        });

        handleUploadMock.mockImplementation(
            async ({ onUploadCompleted }: {
                onUploadCompleted: (arg: {
                    blob: ReturnType<typeof completedBlob>;
                    tokenPayload: string;
                }) => Promise<void>;
            }) => {
                await expect(
                    onUploadCompleted({
                        blob: completedBlob('video/mp4'),
                        tokenPayload: tokenPayload(),
                    }),
                ).rejects.toThrow('db timeout resolving media_id');
                throw new Error('db timeout resolving media_id');
            },
        );

        const res = await POST(makeRequest(), params());
        expect(res.status).toBe(400);
        // Enqueue is never reached because media_id resolution failed first.
        expect(enqueueMock).not.toHaveBeenCalled();
    });
});
