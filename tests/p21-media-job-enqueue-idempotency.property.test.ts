// Property tests for Task 2.3 — media-jobs enqueue properties P1 & P2.
//
// **P1 — Enqueue idempotency per kind** (design.md "Correctness Properties"):
//   Any sequence of `enqueueMediaJob(db, mediaId, kind)` calls yields exactly
//   one job per (mediaId, kind) pair in the queue — regardless of how many times
//   enqueue is called or in what order.
//   Validates: Requirements 5.1, 5.2
//
// **P2 — Independent kinds** (design.md "Correctness Properties"):
//   A failing enqueue for one kind (db error thrown) does NOT affect the
//   independent state of another kind for the same mediaId. Each kind's job
//   slot is entirely separate.
//   Validates: Requirements 5.3, 5.4
//
// Modeling approach (mirrors the in-memory-reference style of P8/P9):
//   - The only mocked boundary is the pg executor. An IN-MEMORY model of
//     `media_jobs` enforces the unique index on (media_id, kind) and the
//     `ON CONFLICT (media_id, kind) DO NOTHING` semantics ATOMICALLY — exactly
//     as Postgres's unique index does.
//   - The REAL `enqueueMediaJob` from `lib/media-jobs.ts` runs against the fake.
//   - Effectful boundaries (real DB, network) are never touched.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { Pool } from 'pg';
import { enqueueMediaJob, type MediaJobKind } from '@/lib/media-jobs';

// ---------------------------------------------------------------------------
// In-memory media_jobs model
// ---------------------------------------------------------------------------

interface MediaJobRow {
    id: number;
    media_id: number;
    kind: MediaJobKind;
    status: string;
    attempts: number;
}

/**
 * Models `public.media_jobs` with the unique index on (media_id, kind).
 *
 * The only SQL accepted is the INSERT ... ON CONFLICT (media_id, kind) DO
 * NOTHING that `enqueueMediaJob` issues. The check-and-insert is indivisible —
 * exactly like Postgres enforcing a composite unique index — so concurrent calls
 * converge to at most one row per (media_id, kind) pair.
 */
interface MediaJobsModel {
    query: Pool['query'];
    hasJob: (mediaId: number, kind: MediaJobKind) => boolean;
    jobsForKind: (mediaId: number, kind: MediaJobKind) => MediaJobRow[];
    totalJobs: () => number;
    insertCount: () => number;
}

function createMediaJobsModel(): MediaJobsModel {
    // Composite key: `${media_id}:${kind}` → row.
    const byKey = new Map<string, MediaJobRow>();
    let nextId = 1;
    let inserts = 0;

    function key(mediaId: number, kind: MediaJobKind): string {
        return `${mediaId}:${kind}`;
    }

    async function query(
        sql: string,
        params?: unknown[],
    ): Promise<{ rowCount: number; rows: MediaJobRow[] }> {
        if (/INSERT INTO media_jobs/i.test(sql)) {
            const mediaId = (params ?? [])[0] as number;
            const kind = (params ?? [])[1] as MediaJobKind;
            const k = key(mediaId, kind);

            if (byKey.has(k)) {
                // ON CONFLICT (media_id, kind) DO NOTHING — unique index fires.
                return { rowCount: 0, rows: [] };
            }

            const row: MediaJobRow = {
                id: nextId++,
                media_id: mediaId,
                kind,
                status: 'pending',
                attempts: 0,
            };
            byKey.set(k, row);
            inserts++;
            return { rowCount: 1, rows: [row] };
        }
        throw new Error(`Unexpected query in media-jobs model: ${sql}`);
    }

    return {
        query: query as unknown as Pool['query'],
        hasJob: (mediaId, kind) => byKey.has(key(mediaId, kind)),
        jobsForKind: (mediaId, kind) => {
            const row = byKey.get(key(mediaId, kind));
            return row ? [row] : [];
        },
        totalJobs: () => byKey.size,
        insertCount: () => inserts,
    };
}

// ---------------------------------------------------------------------------
// fast-check generators
// ---------------------------------------------------------------------------

const ALL_KINDS: MediaJobKind[] = ['poster', 'image', 'video'];
const kindArb = fc.constantFrom<MediaJobKind>(...ALL_KINDS);
const mediaIdArb = fc.integer({ min: 1, max: 1_000_000 });

// A scenario for one (mediaId, kind) pair enqueued N times.
const singleKindScenarioArb = fc.record({
    mediaId: mediaIdArb,
    kind: kindArb,
    calls: fc.integer({ min: 1, max: 10 }),
});

// A scenario with one mediaId and an array of (kind, calls) entries covering
// all three kinds independently.
const multiKindScenarioArb = fc.record({
    mediaId: mediaIdArb,
    entries: fc.array(
        fc.record({
            kind: kindArb,
            calls: fc.integer({ min: 1, max: 6 }),
        }),
        { minLength: 1, maxLength: 12 },
    ),
});

// A scenario across many mediaIds and kinds at once.
const broadScenarioArb = fc.array(
    fc.record({
        mediaId: fc.integer({ min: 1, max: 50 }),
        kind: kindArb,
        calls: fc.integer({ min: 1, max: 5 }),
    }),
    { minLength: 1, maxLength: 30 },
);

const NUM_RUNS = 200;

// ---------------------------------------------------------------------------
// P1 — Enqueue idempotency per kind
// Validates: Requirements 5.1, 5.2
// ---------------------------------------------------------------------------

describe('P1 — enqueue idempotency: exactly one job per (mediaId, kind)', () => {
    it('SEQUENTIAL: repeated enqueue of the same (mediaId, kind) yields exactly one job', async () => {
        await fc.assert(
            fc.asyncProperty(singleKindScenarioArb, async ({ mediaId, kind, calls }) => {
                const model = createMediaJobsModel();
                const results: boolean[] = [];

                for (let i = 0; i < calls; i++) {
                    results.push(await enqueueMediaJob(model, mediaId, kind));
                }

                // Exactly one job exists for this (mediaId, kind).
                expect(model.jobsForKind(mediaId, kind).length).toBe(1);

                // Exactly one call returned true (inserted); the rest were no-op conflicts.
                const inserted = results.filter((r) => r === true);
                expect(inserted.length).toBe(1);
                expect(results.filter((r) => r === false).length).toBe(calls - 1);

                // Model only ever created one row in total.
                expect(model.insertCount()).toBe(1);
                expect(model.totalJobs()).toBe(1);
            }),
            { numRuns: NUM_RUNS },
        );
    });

    it('CONCURRENT: concurrent enqueue of the same (mediaId, kind) converges to one job', async () => {
        await fc.assert(
            fc.asyncProperty(singleKindScenarioArb, async ({ mediaId, kind, calls }) => {
                const model = createMediaJobsModel();

                // Fire all calls without intermediate awaits to model the
                // confirm-route / webhook race (both enqueue paths).
                const pending: Promise<boolean>[] = [];
                for (let i = 0; i < calls; i++) {
                    pending.push(enqueueMediaJob(model, mediaId, kind));
                }
                const results = await Promise.all(pending);

                // Uniqueness still holds under concurrency.
                expect(model.jobsForKind(mediaId, kind).length).toBe(1);
                expect(results.filter((r) => r === true).length).toBe(1);
                expect(model.insertCount()).toBe(1);
            }),
            { numRuns: NUM_RUNS },
        );
    });

    it('MULTI-KIND: distinct kinds for the same mediaId each get exactly one job', async () => {
        await fc.assert(
            fc.asyncProperty(multiKindScenarioArb, async ({ mediaId, entries }) => {
                const model = createMediaJobsModel();

                // Interleave all calls in flat order so kinds are mixed together.
                const ops: MediaJobKind[] = [];
                for (const { kind, calls } of entries) {
                    for (let i = 0; i < calls; i++) ops.push(kind);
                }
                for (const kind of ops) {
                    await enqueueMediaJob(model, mediaId, kind);
                }

                const distinctKinds = new Set(entries.map((e) => e.kind));

                // One job per distinct (mediaId, kind) — no duplicates.
                expect(model.totalJobs()).toBe(distinctKinds.size);
                expect(model.insertCount()).toBe(distinctKinds.size);
                for (const kind of distinctKinds) {
                    expect(model.jobsForKind(mediaId, kind).length).toBe(1);
                }
            }),
            { numRuns: NUM_RUNS },
        );
    });

    it('BROAD: distinct (mediaId, kind) pairs across many rows each yield exactly one job', async () => {
        await fc.assert(
            fc.asyncProperty(broadScenarioArb, async (entries) => {
                const model = createMediaJobsModel();

                for (const { mediaId, kind, calls } of entries) {
                    for (let i = 0; i < calls; i++) {
                        await enqueueMediaJob(model, mediaId, kind);
                    }
                }

                const distinctPairs = new Set(entries.map((e) => `${e.mediaId}:${e.kind}`));

                expect(model.totalJobs()).toBe(distinctPairs.size);
                expect(model.insertCount()).toBe(distinctPairs.size);
            }),
            { numRuns: NUM_RUNS },
        );
    });
});

// ---------------------------------------------------------------------------
// P2 — Independent kinds: a failing kind never affects another kind
// Validates: Requirements 5.3, 5.4
// ---------------------------------------------------------------------------

/**
 * Creates an executor that throws a DB error for a specific (mediaId, kind)
 * pair but behaves like the real model for all other (mediaId, kind) pairs.
 * This models a transient or permanent DB failure for one job kind without
 * any contamination of the other kinds' job slots.
 */
function createFaultingModel(
    faultMediaId: number,
    faultKind: MediaJobKind,
): MediaJobsModel & { errorCount: () => number } {
    const base = createMediaJobsModel();
    let errors = 0;

    const faultingQuery: Pool['query'] = (async (sql: string, params?: unknown[]) => {
        if (/INSERT INTO media_jobs/i.test(sql)) {
            const mediaId = (params ?? [])[0] as number;
            const kind = (params ?? [])[1] as MediaJobKind;
            if (mediaId === faultMediaId && kind === faultKind) {
                errors++;
                throw new Error(`Simulated DB error for (${mediaId}, ${kind})`);
            }
        }
        // Delegate all other queries to the base model.
        // base.query is typed as Pool['query'], so the call is safe.
        return (base.query as (sql: string, params?: unknown[]) => Promise<unknown>)(sql, params);
    }) as unknown as Pool['query'];

    return {
        query: faultingQuery,
        hasJob: base.hasJob,
        jobsForKind: base.jobsForKind,
        totalJobs: base.totalJobs,
        insertCount: base.insertCount,
        errorCount: () => errors,
    };
}

describe('P2 — independent kinds: a failing kind never blocks another kind', () => {
    it('enqueue failure for kind A does not prevent kind B from being enqueued', async () => {
        await fc.assert(
            fc.asyncProperty(
                mediaIdArb,
                // Pick two distinct kinds: the one that will fail and the one that must succeed.
                fc.tuple(kindArb, kindArb).filter(([a, b]) => a !== b),
                async (mediaId, [faultKind, successKind]) => {
                    const model = createFaultingModel(mediaId, faultKind);

                    // Attempt the faulting kind — it should throw.
                    await expect(
                        enqueueMediaJob(model, mediaId, faultKind),
                    ).rejects.toThrow();

                    // The healthy kind enqueues successfully, completely unaffected.
                    const inserted = await enqueueMediaJob(model, mediaId, successKind);
                    expect(inserted).toBe(true);
                    expect(model.hasJob(mediaId, successKind)).toBe(true);

                    // The faulting kind's slot is still empty (no phantom job).
                    expect(model.hasJob(mediaId, faultKind)).toBe(false);

                    // Exactly one job exists in the queue (the healthy kind).
                    expect(model.totalJobs()).toBe(1);
                    expect(model.insertCount()).toBe(1);
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });

    it('a poster failure for a video row does not prevent the video job from being enqueued', async () => {
        // Concrete scenario from the design: for a video row, the confirm route
        // enqueues both 'poster' and 'video'. If 'poster' throws, 'video' must
        // still succeed (Req 5.4).
        await fc.assert(
            fc.asyncProperty(mediaIdArb, async (mediaId) => {
                const model = createFaultingModel(mediaId, 'poster');

                // Enqueue poster — expected to throw (DB error for this kind).
                await expect(enqueueMediaJob(model, mediaId, 'poster')).rejects.toThrow();

                // Enqueue video — must succeed regardless.
                const videoInserted = await enqueueMediaJob(model, mediaId, 'video');
                expect(videoInserted).toBe(true);
                expect(model.hasJob(mediaId, 'video')).toBe(true);
                expect(model.hasJob(mediaId, 'poster')).toBe(false);

                // Only the video job exists.
                expect(model.totalJobs()).toBe(1);
            }),
            { numRuns: NUM_RUNS },
        );
    });

    it('failures for all other kinds do not prevent an image job from succeeding', async () => {
        // For an image row the confirm route enqueues 'image'. Even if 'poster'
        // and 'video' fail for the same mediaId, 'image' is unaffected (Req 5.4).
        await fc.assert(
            fc.asyncProperty(mediaIdArb, async (mediaId) => {
                // Fault 'poster' and 'video' for this mediaId.
                const modelFaultPoster = createFaultingModel(mediaId, 'poster');

                // We need a model that faults both poster and video.
                // Build a two-fault executor on top: chain two faulting layers.
                const innerModel = createFaultingModel(mediaId, 'poster');
                const outerQuery: Pool['query'] = (async (sql: string, params?: unknown[]) => {
                    if (/INSERT INTO media_jobs/i.test(sql)) {
                        const kind = (params ?? [])[1] as MediaJobKind;
                        if ((params ?? [])[0] === mediaId && kind === 'video') {
                            throw new Error(`Simulated DB error for (${mediaId}, video)`);
                        }
                    }
                    return (innerModel.query as (sql: string, params?: unknown[]) => Promise<unknown>)(sql, params);
                }) as unknown as Pool['query'];

                const dualFaultModel: MediaJobsModel = {
                    query: outerQuery,
                    hasJob: innerModel.hasJob,
                    jobsForKind: innerModel.jobsForKind,
                    totalJobs: innerModel.totalJobs,
                    insertCount: innerModel.insertCount,
                };

                // Both poster and video fail.
                await expect(enqueueMediaJob(dualFaultModel, mediaId, 'poster')).rejects.toThrow();
                await expect(enqueueMediaJob(dualFaultModel, mediaId, 'video')).rejects.toThrow();

                // Image succeeds — completely independent.
                const imageInserted = await enqueueMediaJob(dualFaultModel, mediaId, 'image');
                expect(imageInserted).toBe(true);
                expect(dualFaultModel.hasJob(mediaId, 'image')).toBe(true);
                expect(dualFaultModel.hasJob(mediaId, 'poster')).toBe(false);
                expect(dualFaultModel.hasJob(mediaId, 'video')).toBe(false);
                expect(dualFaultModel.totalJobs()).toBe(1);

                // Suppress unused variable warning.
                void modelFaultPoster;
            }),
            { numRuns: NUM_RUNS },
        );
    });

    it('all three kinds can succeed independently for the same mediaId', async () => {
        // No faults: confirm enqueues poster+video for a video row, or image for
        // an image row. Verify all three kinds are independent slots.
        await fc.assert(
            fc.asyncProperty(mediaIdArb, async (mediaId) => {
                const model = createMediaJobsModel();

                const r1 = await enqueueMediaJob(model, mediaId, 'poster');
                const r2 = await enqueueMediaJob(model, mediaId, 'image');
                const r3 = await enqueueMediaJob(model, mediaId, 'video');

                // All three inserted (they are distinct slots).
                expect(r1).toBe(true);
                expect(r2).toBe(true);
                expect(r3).toBe(true);
                expect(model.totalJobs()).toBe(3);
                expect(model.insertCount()).toBe(3);

                // Repeat enqueue of each is a no-op.
                const r1b = await enqueueMediaJob(model, mediaId, 'poster');
                const r2b = await enqueueMediaJob(model, mediaId, 'image');
                const r3b = await enqueueMediaJob(model, mediaId, 'video');
                expect(r1b).toBe(false);
                expect(r2b).toBe(false);
                expect(r3b).toBe(false);
                expect(model.totalJobs()).toBe(3);
                expect(model.insertCount()).toBe(3);
            }),
            { numRuns: NUM_RUNS },
        );
    });
});
