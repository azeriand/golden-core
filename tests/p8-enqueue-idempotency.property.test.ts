// Property test P8 — "Enqueue idempotency — at most one job per media_id" —
// Task 2.2.
//
// Property 1 (design.md "Correctness Properties"):
//   For any media id and any sequence of one or more `enqueuePosterJob` calls
//   for that media id (in any order, with any interleaving of the two enqueue
//   paths), the final set of poster jobs contains exactly one job for that
//   media id.
//   Validates: Requirements 2.4, 4.5, 5.1, 5.2, 5.3, 3.3, 4.2
//
// This is a UNIT-level property against the REAL enqueue helper
// (lib/poster-jobs.ts `enqueuePosterJob`). The only mocked boundary is the pg
// executor: a fresh IN-MEMORY model of `public.poster_jobs` that enforces the
// unique index on media_id + `ON CONFLICT (media_id) DO NOTHING` ATOMICALLY.
// That atomic INSERT-or-conflict is the crux — it MODELS the Postgres unique
// index that the migration creates (poster_jobs_media_id_key), NOT a real DB.
//
// "Both enqueue paths" (Confirm_Route and Webhook_Path) funnel through this one
// helper, so interleaving the two paths is modeled as interleaving repeated
// calls to `enqueuePosterJob` for the same media id. Concurrency is modeled at
// the JS async-step (event-loop) interleaving level, not true OS-thread
// parallelism — the model's insert decision is indivisible, exactly like
// Postgres enforcing a unique index.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { Pool } from 'pg';
import { enqueuePosterJob } from '@/lib/poster-jobs';

// --- In-memory poster_jobs model ---------------------------------------------

interface PosterJobRow {
    id: number;
    media_id: number;
    status: string;
    attempts: number;
}

// Models `public.poster_jobs` with the unique index on media_id. The ONLY way a
// row is ever added is through the atomic INSERT-or-conflict `query` below, so
// the unique constraint can never be violated — mirroring the DB.
interface PosterJobsModel {
    // Typed as pg's own Pool.query (its full overloaded signature) so the model
    // is assignable to the `Executor = Pick<Pool | PoolClient, 'query'>`
    // parameter of enqueuePosterJob under tsc. The single-string-SQL overload is
    // the only one the helper actually calls.
    query: Pool['query'];
    jobsFor: (mediaId: number) => PosterJobRow[];
    totalJobs: () => number;
    insertCount: () => number;
}

function createPosterJobsModel(): PosterJobsModel {
    // media_id -> the single row that exists for it (unique-index analog).
    const byMediaId = new Map<number, PosterJobRow>();
    let nextId = 1;
    let inserts = 0; // number of INSERTs that actually created a row.

    async function query(
        sql: string,
        params?: unknown[],
    ): Promise<{ rowCount: number; rows: PosterJobRow[] }> {
        // INSERT INTO poster_jobs (...) VALUES (...) ON CONFLICT (media_id) DO NOTHING
        // THE CRUX: a single, synchronous, ATOMIC check-and-insert keyed by
        // media_id. There is NO separate "SELECT existence then INSERT" — the
        // decision is indivisible, exactly like Postgres enforcing the unique
        // index poster_jobs_media_id_key.
        if (/INSERT INTO poster_jobs/i.test(sql)) {
            const mediaId = (params ?? [])[0] as number;
            if (byMediaId.has(mediaId)) {
                // Conflict: the unique index rejects the insert -> DO NOTHING ->
                // zero rows affected. rowCount 0 signals "already existed".
                return { rowCount: 0, rows: [] };
            }
            const row: PosterJobRow = {
                id: nextId++,
                media_id: mediaId,
                status: 'pending',
                attempts: 0,
            };
            byMediaId.set(mediaId, row);
            inserts++;
            return { rowCount: 1, rows: [row] };
        }
        throw new Error(`Unexpected query in P8 model: ${sql}`);
    }

    return {
        // One localized cast adapts the plain (sql, params) implementation to
        // pg's overloaded Pool['query'] type (mirrors how a real pg client
        // satisfies its many overloads with a single body).
        query: query as unknown as Pool['query'],
        jobsFor: (mediaId: number) => {
            const row = byMediaId.get(mediaId);
            return row ? [row] : [];
        },
        totalJobs: () => byMediaId.size,
        insertCount: () => inserts,
    };
}

// --- fast-check generators ----------------------------------------------------

// A scenario for ONE media id enqueued repeatedly (retries + dual-path
// convergence). At least 1 call; up to 10 to exercise heavy repetition.
const scenarioArb = fc.record({
    // Positive media_id (bigserial/serial ids are >= 1 in the schema).
    mediaId: fc.integer({ min: 1, max: 1_000_000 }),
    calls: fc.integer({ min: 1, max: 10 }),
});

// A multi-media scenario: several distinct media ids, each enqueued a number of
// times, all against ONE shared model — the final job count must equal the
// number of DISTINCT media ids.
const multiScenarioArb = fc.array(
    fc.record({
        mediaId: fc.integer({ min: 1, max: 50 }),
        calls: fc.integer({ min: 1, max: 6 }),
    }),
    { minLength: 1, maxLength: 20 },
);

const NUM_RUNS = 200;

// --- Shared assertions --------------------------------------------------------

function assertExactlyOne(
    model: PosterJobsModel,
    mediaId: number,
    results: boolean[],
): void {
    // (a) CORE: exactly one job exists for this media id.
    expect(model.jobsFor(mediaId).length).toBe(1);

    // (b) Exactly one call actually inserted (returned true); the rest were
    //     no-op conflicts (returned false). This is the observable idempotency
    //     contract of enqueuePosterJob's boolean return.
    const inserted = results.filter((r) => r === true);
    const conflicts = results.filter((r) => r === false);
    expect(inserted.length).toBe(1);
    expect(conflicts.length).toBe(results.length - 1);

    // (c) The model only ever created one row (no duplicate rows).
    expect(model.insertCount()).toBe(1);
}

describe('P8 — enqueue idempotency: at most one job per media_id', () => {
    it('SEQUENTIAL: repeated enqueue of one media_id yields exactly one job', async () => {
        await fc.assert(
            fc.asyncProperty(scenarioArb, async (s) => {
                const model = createPosterJobsModel();

                const results: boolean[] = [];
                for (let i = 0; i < s.calls; i++) {
                    results.push(await enqueuePosterJob(model, s.mediaId));
                }

                assertExactlyOne(model, s.mediaId, results);
            }),
            { numRuns: NUM_RUNS },
        );
    });

    it('CONCURRENT: interleaved enqueue of one media_id converges on a single job', async () => {
        await fc.assert(
            fc.asyncProperty(scenarioArb, async (s) => {
                const model = createPosterJobsModel();

                // Fire all enqueue calls WITHOUT awaiting between them so their
                // async steps interleave on the event loop (models the two
                // enqueue paths racing), then await together. The model's
                // INSERT-or-conflict is atomic, so they converge to one job.
                const pending: Promise<boolean>[] = [];
                for (let i = 0; i < s.calls; i++) {
                    pending.push(enqueuePosterJob(model, s.mediaId));
                }
                const results = await Promise.all(pending);

                assertExactlyOne(model, s.mediaId, results);
            }),
            { numRuns: NUM_RUNS },
        );
    });

    it('MULTI: distinct media_ids each converge to exactly one job in a shared queue', async () => {
        await fc.assert(
            fc.asyncProperty(multiScenarioArb, async (entries) => {
                const model = createPosterJobsModel();

                // Interleave enqueue calls across all media ids in an arbitrary
                // flat order, so different media ids' calls are mixed together.
                const ops: number[] = [];
                for (const e of entries) {
                    for (let i = 0; i < e.calls; i++) ops.push(e.mediaId);
                }
                for (const mediaId of ops) {
                    await enqueuePosterJob(model, mediaId);
                }

                const distinct = new Set(entries.map((e) => e.mediaId));
                // One job per distinct media id — no duplicates, none missing.
                expect(model.totalJobs()).toBe(distinct.size);
                expect(model.insertCount()).toBe(distinct.size);
                for (const mediaId of distinct) {
                    expect(model.jobsFor(mediaId).length).toBe(1);
                }
            }),
            { numRuns: NUM_RUNS },
        );
    });
});
