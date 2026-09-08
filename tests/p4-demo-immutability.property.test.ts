// Property test P4 — "Demo immutability across upload entry points" — Task 13.4.
//
// Property P4 (design.md / tasks.md):
//   For every new upload entry point (upload-token handshake, confirm, and the
//   onUploadCompleted reconciliation webhook), a request targeting the `demo`
//   event OR coming from the demo user ALWAYS yields 403 (where the route
//   answers a request) and creates NO Blob token and NO `media` row — regardless
//   of repeats, retries, malformed/adversarial client payloads, injected demo
//   flags, or combinations.
//   Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 19.9
//
// SCOPE NOTE (this task): per the 13.4 execution brief this file covers the NEW
// entry points (upload-token / confirm / onUploadCompleted). The legacy
// `POST .../media` + bulk demo parity is audited/covered elsewhere (13.9) and by
// the legacy route's own demo guard; it is intentionally NOT re-exercised here.
//
// This is a UNIT-level property against the REAL route handlers with the REAL
// demo-guard (lib/demo-guard.ts) and the REAL verifyRequest (lib/auth.ts, driven
// with real signed JWTs). Only external boundaries are mocked:
//   - `@/lib/db`            -> pool.query, dispatched by SQL text against an
//                              IN-MEMORY media model that RECORDS every attempted
//                              INSERT (insertAttempts counter). For a demo
//                              scenario the property fails if an INSERT is even
//                              REACHED — not merely if a row survives.
//   - `@vercel/blob`        -> head (blob exists, so the demo rejection is proven
//                              to happen regardless of blob state) / del (spy) /
//                              BlobNotFoundError.
//   - `@vercel/blob/client` -> handleUpload (a faithful, controllable fake that
//                              lets us (a) prove the route's pre-check returns 403
//                              WITHOUT calling handleUpload for a demo event/user,
//                              and (b) drive the route's REAL onBeforeGenerateToken
//                              and onUploadCompleted callbacks the way the SDK
//                              would, to exercise their demo defenses).
//   We DELIBERATELY do NOT mock demo-guard or verifyRequest's demo-relevant logic.
//
// The in-memory model is NOT a real Postgres (real DB / real webhook proof is
// task 13.7). Concurrency here is JS async-step interleaving, not OS threads.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import jwt from 'jsonwebtoken';
import { NextRequest } from 'next/server';

// --- Mock external boundaries BEFORE importing the routes --------------------
// `vi.mock` factories are hoisted; anything they reference must come from
// `vi.hoisted`. We expose mutable holders so each property run installs a fresh
// in-memory DB model / handleUpload behaviour without re-registering the mock.
const { dbState, headMock, delMock, handleUploadState, FakeBlobNotFoundError } =
    vi.hoisted(() => {
        class FakeBlobNotFoundError extends Error {
            constructor() {
                super('Blob not found');
                this.name = 'BlobNotFoundError';
            }
        }
        const dbState: {
            query: (sql: string, params?: unknown[]) => Promise<unknown>;
        } = {
            query: async () => {
                throw new Error('db model not initialised');
            },
        };
        // handleUploadState.impl is swapped per test with a faithful fake that
        // captures the route's callbacks.
        const handleUploadState: {
            impl: (args: unknown) => Promise<unknown>;
        } = {
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

// Faithful, controllable fake for the SDK entry point. The route calls
// handleUpload({ request, body, onBeforeGenerateToken, onUploadCompleted }); our
// fake records that it was called and lets each test decide what to do with the
// captured callbacks (mimicking what the real SDK does).
vi.mock('@vercel/blob/client', () => ({
    handleUpload: (args: unknown) => handleUploadState.impl(args),
}));

// Import AFTER mocks are registered.
import { POST as confirmPOST } from '@/app/api/event/[event-slug]/media/confirm/route';
import { POST as uploadTokenPOST } from '@/app/api/event/[event-slug]/media/upload-token/route';

// --- Constants mirroring the real demo-guard --------------------------------
const DEMO_SLUG = 'demo';
const DEMO_EMAIL = 'demo@golden-core.app';

const TEST_SECRET = 'p4-property-test-secret';
const EVENT_ID = 12;
const SECTION_ID = 99;
const NORMAL_EMAIL = 'user@example.test';
const NORMAL_SLUG = 'my-event';
const BLOB_HOST = 'https://blob.example.com';

function signToken(email: string): string {
    return jwt.sign({ userId: 5, email, isAdmin: false }, TEST_SECRET, {
        expiresIn: '1h',
    });
}

// --- In-memory media model that OBSERVES every attempted write ---------------
// The crux of P4: any INSERT INTO media that the handler REACHES increments
// insertAttempts. Demo properties assert insertAttempts === 0 (attempted-reach,
// not just final row count). A pre-existing NON-demo control row can be seeded to
// assert it is never mutated/removed.

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
    insertAttempts: () => number;
    updateDeleteAttempts: () => number;
    totalRows: () => number;
    rowsFor: (uploadId: string) => MediaRow[];
    snapshot: () => Map<string, MediaRow>;
}

function createMediaTableModel(seed?: MediaRow): MediaTableModel {
    const byUploadId = new Map<string, MediaRow>();
    if (seed) byUploadId.set(seed.upload_id, { ...seed });
    let nextMediaId = 1000;
    let insertAttempts = 0; // # of INSERT statements REACHED (observable)
    let updateDeleteAttempts = 0; // # of UPDATE/DELETE statements REACHED

    async function query(sql: string, params?: unknown[]): Promise<unknown> {
        if (/FROM events/i.test(sql)) {
            return { rows: [{ event_id: EVENT_ID }] };
        }
        if (/FROM sections/i.test(sql)) {
            return { rows: [{ section_id: SECTION_ID }] };
        }
        if (/INSERT INTO media/i.test(sql)) {
            // OBSERVABLE-REACH: record that a mutation was attempted the instant
            // the handler runs the INSERT — before deciding conflict/no-conflict.
            insertAttempts++;
            const p = params ?? [];
            const uploadId = p[7] as string;
            if (byUploadId.has(uploadId)) {
                return { rows: [], rowCount: 0 }; // conflict
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
            return { rows: [row], rowCount: 1 };
        }
        if (/^\s*UPDATE\s+media/i.test(sql) || /^\s*DELETE\s+FROM\s+media/i.test(sql)) {
            updateDeleteAttempts++;
            return { rows: [], rowCount: 0 };
        }
        if (/SELECT \* FROM media/i.test(sql)) {
            const uploadId = (params ?? [])[0] as string;
            const row = byUploadId.get(uploadId);
            return { rows: row ? [row] : [] };
        }
        // shapeMediaRow's DTO enrichment SELECT (`... FROM users LEFT JOIN
        //    likes ...`). It is a pure READ (never a media write), so it does
        //    NOT touch insertAttempts/updateDeleteAttempts — demo scenarios
        //    never reach it anyway (they 403 before any confirm insert). Only
        //    the non-demo CONTROL case reaches it.
        if (/FROM users/i.test(sql)) {
            return { rows: [{ username: 'tester', likes: 0, liked: false }] };
        }
        throw new Error(`Unexpected query in P4 model: ${sql}`);
    }

    return {
        query,
        insertAttempts: () => insertAttempts,
        updateDeleteAttempts: () => updateDeleteAttempts,
        totalRows: () => byUploadId.size,
        rowsFor: (uploadId) => {
            const row = byUploadId.get(uploadId);
            return row ? [row] : [];
        },
        snapshot: () => new Map([...byUploadId].map(([k, v]) => [k, { ...v }])),
    };
}

// --- request/params helpers --------------------------------------------------

function makeRequest(body: unknown, email: string, withToken = true): NextRequest {
    const req = new NextRequest('https://example.test/api/upload', {
        method: 'POST',
        body: typeof body === 'string' ? body : JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
    });
    if (withToken) req.cookies.set('auth_token', signToken(email));
    return req;
}

function params(slug: string): { params: Promise<{ 'event-slug': string }> } {
    return { params: Promise.resolve({ 'event-slug': slug }) };
}

// --- fast-check generators ---------------------------------------------------

// Demo scenario: cover BOTH Req 4 dimensions (demo EVENT and/or demo USER).
type DemoDim = 'demo-event' | 'demo-user' | 'both';

const demoDimArb: fc.Arbitrary<DemoDim> = fc.constantFrom(
    'demo-event',
    'demo-user',
    'both',
);

// A UUID that is usually valid v4 but occasionally malformed (to test rejection
// paths never leading to a write).
const uploadIdArb = fc.oneof(
    { weight: 4, arbitrary: fc.uuid({ version: 4 }) },
    { weight: 1, arbitrary: fc.constantFrom('not-a-uuid', '', '1234', '../../etc') },
);

const contentTypeArb = fc.oneof(
    {
        weight: 4,
        arbitrary: fc.constantFrom('image/jpeg', 'image/png', 'image/webp', 'video/mp4'),
    },
    // Occasionally a disallowed type — must still be 403 (demo blocks first).
    { weight: 1, arbitrary: fc.constantFrom('application/zip', 'text/plain', 'application/x-msdownload') },
);

const isoDateArb = fc
    .integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2035, 0, 1) })
    .map((ms) => new Date(ms).toISOString());

const filenameArb = fc.oneof(
    fc.stringMatching(/^[a-z0-9]{1,12}$/).map((s) => `${s || 'photo'}.jpg`),
    // Adversarial filenames (traversal-ish); must not matter — demo blocks first.
    fc.constantFrom('../../evil.jpg', '..\\..\\evil.png', '/abs/path.mp4'),
);

// Adversarial client-controlled fields injected into bodies/payloads to PROVE a
// client-provided demo flag / injected id is NOT authoritative.
const adversarialExtrasArb = fc.record(
    {
        isDemo: fc.boolean(),
        demo: fc.boolean(),
        isAdmin: fc.constant(true),
        bypass: fc.constant(true),
        event_id: fc.integer({ min: 1, max: 9999 }),
        eventId: fc.integer({ min: 1, max: 9999 }),
        userId: fc.integer({ min: 1, max: 9999 }),
    },
    { requiredKeys: [] },
);

const demoScenarioArb = fc.record({
    dim: demoDimArb,
    uploadId: uploadIdArb,
    contentType: contentTypeArb,
    date: isoDateArb,
    filename: filenameArb,
    // Adversarial blobUrl variants: point at a DIFFERENT (non-demo) event's
    // namespace, or traversal-ish — must never flip a demo request writable.
    blobEventId: fc.oneof(fc.constant(EVENT_ID), fc.integer({ min: 1, max: 9999 })),
    extras: adversarialExtrasArb,
    attempts: fc.integer({ min: 1, max: 5 }),
});

// Resolve which slug + which JWT email a demo dimension implies.
function slugForDim(dim: DemoDim): string {
    return dim === 'demo-user' ? NORMAL_SLUG : DEMO_SLUG;
}
function emailForDim(dim: DemoDim): string {
    return dim === 'demo-event' ? NORMAL_EMAIL : DEMO_EMAIL;
}

// Build a confirm body (with adversarial extras merged in).
function buildConfirmBody(s: {
    uploadId: string;
    contentType: string;
    date: string;
    filename: string;
    blobEventId: number;
    extras: Record<string, unknown>;
}): Record<string, unknown> {
    return {
        uploadId: s.uploadId,
        blobUrl: `${BLOB_HOST}/events/${s.blobEventId}/${s.uploadId}/${s.filename}`,
        filename: s.filename,
        contentType: s.contentType,
        originalSize: 2_000_000,
        processedSize: 400_000,
        date: s.date,
        blurhash: 'LEHV6nWB2yk8',
        // Adversarial injected fields — must be ignored by the server.
        ...s.extras,
    };
}

// Build the upload-token request body. The real route reads request.json() and
// passes it to handleUpload; for the demo PRE-CHECK path handleUpload is never
// reached, so body shape is not important there. We still send a plausible
// HandleUploadBody-ish object with adversarial extras.
function buildUploadTokenBody(s: {
    uploadId: string;
    contentType: string;
    date: string;
    filename: string;
    extras: Record<string, unknown>;
}): Record<string, unknown> {
    return {
        type: 'blob.generate-client-token',
        payload: {
            pathname: `events/${EVENT_ID}/${s.uploadId}/${s.filename}`,
            callbackUrl: 'https://example.test/api/upload-token',
            clientPayload: JSON.stringify({
                uploadId: s.uploadId,
                eventSlug: NORMAL_SLUG,
                filename: s.filename,
                contentType: s.contentType,
                size: 2_000_000,
                date: s.date,
                ...s.extras,
            }),
            multipart: false,
        },
        ...s.extras,
    };
}

// Shared assertions for a demo scenario after all attempts against one route.
function assertDemoImmutable(
    model: MediaTableModel,
    before: Map<string, MediaRow>,
    responses: Response[],
): void {
    // No INSERT was ever REACHED (observable-reach, not just final row count).
    expect(model.insertAttempts()).toBe(0);
    // No UPDATE/DELETE on media either.
    expect(model.updateDeleteAttempts()).toBe(0);
    // The media table is byte-identical to before (control row untouched).
    const after = model.snapshot();
    expect(after.size).toBe(before.size);
    for (const [k, v] of before) {
        expect(after.get(k)).toEqual(v);
    }
    // Every answered request was 403 (demoGuardResponse).
    for (const res of responses) {
        expect(res.status).toBe(403);
    }
    // del() (Blob delete) was never used on these demo-rejected paths.
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

// A pre-existing NON-demo control row seeded into the model; must never change.
function controlRow(): MediaRow {
    return {
        media_id: 1,
        content: `${BLOB_HOST}/events/${EVENT_ID}/control/keep.jpg`,
        type: 'image/jpeg',
        date: '2023-06-01T00:00:00.000Z',
        user_id: 42,
        section_id: SECTION_ID,
        event_id: EVENT_ID,
        blurhash: 'CONTROL',
        upload_id: '00000000-0000-4000-8000-000000000001',
    };
}

describe('P4 — demo immutability across upload entry points', () => {
    // ---------------------------------------------------------------------
    // (a) CONFIRM route: demo event and/or demo user => 403, zero inserts.
    // Runtime-tested: the real confirm POST is invoked with real demo-guard +
    // real JWT; only DB/Blob are mocked.
    // ---------------------------------------------------------------------
    it('CONFIRM: demo event/user always 403 with no write, across repeats & adversarial bodies', async () => {
        await fc.assert(
            fc.asyncProperty(demoScenarioArb, async (s) => {
                const seeded = controlRow();
                const model = createMediaTableModel(seeded);
                dbState.query = model.query;
                const before = model.snapshot();

                headMock.mockReset();
                delMock.mockReset();
                headMock.mockResolvedValue({ url: 'ok' }); // blob exists regardless
                delMock.mockResolvedValue(undefined);

                const slug = slugForDim(s.dim);
                const email = emailForDim(s.dim);

                const responses: Response[] = [];
                for (let i = 0; i < s.attempts; i++) {
                    const body = buildConfirmBody(s);
                    responses.push(await confirmPOST(makeRequest(body, email), params(slug)));
                }

                assertDemoImmutable(model, before, responses);
            }),
            { numRuns: NUM_RUNS },
        );
    });

    // ---------------------------------------------------------------------
    // (b) UPLOAD-TOKEN route, PRE-CHECK path: demo event/user => 403 and
    // handleUpload is NEVER called (so no token is minted and no callback
    // runs). Runtime-tested against the real route + real demo-guard.
    // ---------------------------------------------------------------------
    it('UPLOAD-TOKEN: demo event/user pre-check returns 403 WITHOUT calling handleUpload', async () => {
        await fc.assert(
            fc.asyncProperty(demoScenarioArb, async (s) => {
                const seeded = controlRow();
                const model = createMediaTableModel(seeded);
                dbState.query = model.query;
                const before = model.snapshot();

                headMock.mockReset();
                delMock.mockReset();
                headMock.mockResolvedValue({ url: 'ok' });
                delMock.mockResolvedValue(undefined);

                // Track handleUpload invocation; if the route ever calls it for a
                // demo scenario that is a defense-in-depth failure of the pre-check.
                let handleUploadCalled = 0;
                handleUploadState.impl = async () => {
                    handleUploadCalled++;
                    // Should not get here for a demo scenario; if it does, return a
                    // benign token so we still observe (and the property will fail
                    // on the assertion below, not on a throw).
                    return { type: 'blob.generate-client-token', clientToken: 'tok' };
                };

                const slug = slugForDim(s.dim);
                const email = emailForDim(s.dim);

                const responses: Response[] = [];
                for (let i = 0; i < s.attempts; i++) {
                    const body = buildUploadTokenBody(s);
                    responses.push(await uploadTokenPOST(makeRequest(body, email), params(slug)));
                }

                // Pre-check must have short-circuited BEFORE handleUpload.
                expect(handleUploadCalled).toBe(0);
                assertDemoImmutable(model, before, responses);
            }),
            { numRuns: NUM_RUNS },
        );
    });

    // ---------------------------------------------------------------------
    // (c) UPLOAD-TOKEN onBeforeGenerateToken defense-in-depth. The route's
    // inner demo gate reads the ROUTE-bound `eventSlug`/`user.email` (closure),
    // NOT the payload. Since handleUpload is only ever reached for a NON-demo
    // slug + NON-demo user (the pre-check blocks demo before the try-block),
    // that inner gate is structurally unreachable at runtime for a demo request
    // — it is genuine defense-in-depth. We therefore RUNTIME-verify two things:
    //   (i) for a demo event/user the route returns 403 WITHOUT reaching
    //       handleUpload (already covered by test (b); re-asserted here per attempt),
    //   (ii) the captured onBeforeGenerateToken, when invoked by our SDK fake on
    //       the NON-demo drive, mints a token config and NEVER touches the media
    //       table (no INSERT/UPDATE/DELETE) — proving token minting is not a write
    //       path. The inner isDemoEvent/isDemoUser re-assertion for a demo slug is
    //       covered by REASONING (see report) because the route cannot reach it
    //       with a demo slug.
    // ---------------------------------------------------------------------
    it('UPLOAD-TOKEN: demo request never reaches handleUpload; token minting is not a media-write path', async () => {
        await fc.assert(
            fc.asyncProperty(demoScenarioArb, async (s) => {
                const model = createMediaTableModel(controlRow());
                dbState.query = model.query;
                const before = model.snapshot();

                headMock.mockReset();
                delMock.mockReset();
                headMock.mockResolvedValue({ url: 'ok' });
                delMock.mockResolvedValue(undefined);

                // (i) DEMO drive: pre-check must 403 without calling handleUpload.
                let demoHandleUploadCalls = 0;
                handleUploadState.impl = async () => {
                    demoHandleUploadCalls++;
                    return { type: 'blob.generate-client-token', clientToken: 'tok' };
                };
                const demoRes = await uploadTokenPOST(
                    makeRequest(buildUploadTokenBody(s), emailForDim(s.dim)),
                    params(slugForDim(s.dim)),
                );
                expect(demoRes.status).toBe(403);
                expect(demoHandleUploadCalls).toBe(0);
                // No write on the demo path.
                expect(model.insertAttempts()).toBe(0);
                expect(model.updateDeleteAttempts()).toBe(0);

                // (ii) NON-demo drive: capture + invoke onBeforeGenerateToken and
                // prove it returns a token config with NO media mutation.
                const validUpload = '44444444-4444-4444-8444-444444444444';
                let tokenConfig: unknown = null;
                handleUploadState.impl = async (args: unknown) => {
                    const a = args as {
                        onBeforeGenerateToken: (
                            pathname: string,
                            clientPayload: string | null,
                        ) => Promise<unknown>;
                    };
                    tokenConfig = await a.onBeforeGenerateToken(
                        `events/${EVENT_ID}/${validUpload}/photo.jpg`,
                        JSON.stringify({
                            uploadId: validUpload,
                            eventSlug: NORMAL_SLUG,
                            filename: 'photo.jpg',
                            contentType: 'image/jpeg',
                            size: 2_000_000,
                            date: s.date,
                        }),
                    );
                    return { type: 'blob.generate-client-token', clientToken: 'tok' };
                };
                await uploadTokenPOST(
                    makeRequest(
                        buildUploadTokenBody({ ...s, uploadId: validUpload }),
                        NORMAL_EMAIL,
                    ),
                    params(NORMAL_SLUG),
                );
                // onBeforeGenerateToken produced a token config (non-demo, valid).
                expect(tokenConfig).not.toBeNull();
                // Token minting reached NO media write.
                expect(model.insertAttempts()).toBe(0);
                expect(model.updateDeleteAttempts()).toBe(0);

                // Control row still byte-identical after both drives.
                const after = model.snapshot();
                expect(after.size).toBe(before.size);
                for (const [k, v] of before) expect(after.get(k)).toEqual(v);
                expect(delMock).not.toHaveBeenCalled();
            }),
            { numRuns: NUM_RUNS },
        );
    });

    // ---------------------------------------------------------------------
    // (d) UPLOAD-TOKEN onUploadCompleted (reconciliation webhook) demo-safety:
    // for a demo EVENT the handler creates NO row. Runtime-tested by capturing
    // the route's onUploadCompleted via our handleUpload fake and invoking it
    // with a crafted { blob, tokenPayload } for the demo event.
    // NOTE: onUploadCompleted only runs for a NON-demo-slug drive (the pre-check
    // blocks a demo slug before handleUpload). Its demo protection is the
    // internal `isDemoEvent(eventSlug)` branch — but that reads the ROUTE slug.
    // To exercise the branch we must reach handleUpload, which requires a
    // non-demo slug, so isDemoEvent(eventSlug) is false there. Therefore the
    // demo-EVENT reconciliation branch is exercised by REASONING/inspection plus
    // the runtime proof that the handshake never mints a token for a demo
    // event/user (parts b/c). We DO runtime-verify that onUploadCompleted, when
    // invoked, does not create a row for a mismatched/forged context. See report.
    // ---------------------------------------------------------------------
    it('UPLOAD-TOKEN onUploadCompleted: invoked reconciliation never creates a row for a forged/demo context', async () => {
        await fc.assert(
            fc.asyncProperty(demoScenarioArb, async (s) => {
                const model = createMediaTableModel(controlRow());
                dbState.query = model.query;
                const before = model.snapshot();

                headMock.mockReset();
                delMock.mockReset();
                headMock.mockResolvedValue({ url: 'ok' });
                delMock.mockResolvedValue(undefined);

                // Capture onUploadCompleted, then invoke it directly with a
                // tokenPayload whose eventId does NOT match the resolved event
                // (forged context) — the handler must create NO row.
                let capturedOnCompleted:
                    | ((event: { blob: unknown; tokenPayload?: string | null }) => Promise<unknown>)
                    | null = null;
                handleUploadState.impl = async (args: unknown) => {
                    const a = args as {
                        onUploadCompleted: (event: {
                            blob: unknown;
                            tokenPayload?: string | null;
                        }) => Promise<unknown>;
                    };
                    capturedOnCompleted = a.onUploadCompleted;
                    return { type: 'blob.upload-completed', response: 'ok' };
                };

                // Drive with a NON-demo slug + NON-demo user so the pre-check
                // passes and handleUpload runs (capturing the callback).
                const validUpload = '22222222-2222-4222-8222-222222222222';
                const body = buildUploadTokenBody({ ...s, uploadId: validUpload });
                await uploadTokenPOST(makeRequest(body, NORMAL_EMAIL), params(NORMAL_SLUG));

                // The route captured onUploadCompleted; if not, the drive failed
                // (e.g. malformed body). Only assert when captured.
                if (typeof capturedOnCompleted === 'function') {
                    // Forged tokenPayload: eventId mismatches the resolved event
                    // (model resolves slug -> EVENT_ID; use a different eventId).
                    await (capturedOnCompleted as (event: {
                        blob: unknown;
                        tokenPayload?: string | null;
                    }) => Promise<unknown>)({
                        blob: {
                            url: `${BLOB_HOST}/events/${EVENT_ID + 777}/${validUpload}/x.jpg`,
                            pathname: `events/${EVENT_ID + 777}/${validUpload}/x.jpg`,
                            contentType: 'image/jpeg',
                        },
                        tokenPayload: JSON.stringify({
                            uploadId: validUpload,
                            userId: 5,
                            eventId: EVENT_ID + 777, // mismatch -> no row
                            date: s.date,
                        }),
                    });
                }

                // No row was created; control row untouched.
                expect(model.insertAttempts()).toBe(0);
                expect(model.updateDeleteAttempts()).toBe(0);
                const after = model.snapshot();
                expect(after.size).toBe(before.size);
                for (const [k, v] of before) expect(after.get(k)).toEqual(v);
            }),
            { numRuns: NUM_RUNS },
        );
    });

    // ---------------------------------------------------------------------
    // CONTROL CASE: prove the harness is NOT vacuous — a NON-demo event +
    // NON-demo user + valid confirm body DOES reach an INSERT and create
    // exactly one row (201). This guards against a false-passing P4.
    // ---------------------------------------------------------------------
    it('CONTROL: a valid non-demo confirm reaches an INSERT and creates exactly one row (201)', async () => {
        const model = createMediaTableModel();
        dbState.query = model.query;
        headMock.mockReset();
        delMock.mockReset();
        headMock.mockResolvedValue({ url: 'ok' });
        delMock.mockResolvedValue(undefined);

        const validUpload = '33333333-3333-4333-8333-333333333333';
        const body = buildConfirmBody({
            uploadId: validUpload,
            contentType: 'image/jpeg',
            date: '2024-01-15T10:30:00.000Z',
            filename: 'photo.jpg',
            blobEventId: EVENT_ID, // must match resolved event for the prefix check
            extras: {},
        });

        const res = await confirmPOST(makeRequest(body, NORMAL_EMAIL), params(NORMAL_SLUG));

        expect(res.status).toBe(201);
        expect(model.insertAttempts()).toBe(1);
        expect(model.totalRows()).toBe(1);
        expect(model.rowsFor(validUpload).length).toBe(1);
    });
});
