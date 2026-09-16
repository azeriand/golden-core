// Property test P13 — "Stale-processing jobs become reclaimable" — Task 7.5.
//
// Property 10 (design.md "Correctness Properties"):
//   For any set of jobs, `reclaimStaleProcessing(timeoutSeconds)` returns every
//   `processing` job whose `updated_at` is OLDER than the stale timeout back to
//   `pending`, and leaves every other job untouched — in particular a
//   `processing` job WITHIN the timeout window is NOT reclaimed, and no
//   pending/done/failed job is ever changed.
//   Validates: Requirements 10.2, 10.3
//
// Modeling approach (mirrors the in-memory-reference style of P10/P11/P12):
//   The queue operation `reclaimStaleProcessing` (worker/src/queue.ts) is pure
//   relative to its SQL contract, so we model `public.poster_jobs` and the exact
//   semantics of the reclaim UPDATE as an IN-MEMORY reference. The ONLY statement
//   the real helper issues is:
//
//       UPDATE poster_jobs
//       SET status = 'pending', updated_at = now()
//       WHERE status = 'processing'
//         AND updated_at < now() - ($1 * interval '1 second')
//
//   i.e. a `processing` row is reclaimed iff its `updated_at` is STRICTLY before
//   the cutoff `now() - timeoutSeconds`. A row exactly AT the cutoff (age ==
//   timeout) is NOT reclaimed (strict `<`). The reference executor interprets
//   this predicate against a fixed `now`, flips matching rows to `pending`,
//   stamps their `updated_at`, and returns the affected row count — exactly what
//   the real helper returns for logging.
//
// TYPING NOTE: the fake executor's `query` is typed as pg's own `Pool['query']`
//   (its full overloaded signature) so the model is assignable to the
//   `Executor = Pick<Pool | PoolClient, 'query'>` parameter of
//   `reclaimStaleProcessing` under `tsc`. The single-string-SQL overload is the
//   only one `reclaimStaleProcessing` actually calls, so the implementation is a
//   plain async function adapted to that overloaded type via one localized cast
//   (mirroring how a real pg client satisfies the many overloads with one body).
//
// We drive the REAL `reclaimStaleProcessing` against this model. Effectful
// boundaries (real DB, ffmpeg, Blob) are out of scope for this pure
// state-machine property.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { Pool } from 'pg';

import { reclaimStaleProcessing } from '../worker/src/queue';

// --- In-memory poster_jobs reference model -----------------------------------

type JobStatus = 'pending' | 'processing' | 'done' | 'failed';

interface JobRow {
    id: number;
    media_id: number;
    status: JobStatus;
    attempts: number;
    run_after_ms: number; // epoch ms (models timestamptz)
    updated_at_ms: number; // epoch ms (models timestamptz)
}

interface PosterJobsModel {
    // Typed as pg's own Pool.query so the model satisfies `Executor` — see
    // TYPING NOTE.
    query: Pool['query'];
    statusOf: (id: number) => JobStatus | undefined;
    updatedAtOf: (id: number) => number | undefined;
    rows: () => JobRow[];
}

// `nowMs` is fixed per model instance so `updated_at < now() - timeout` is
// deterministic without any real waits.
function createPosterJobsModel(seed: JobRow[], nowMs: number): PosterJobsModel {
    const store = new Map<number, JobRow>();
    for (const r of seed) store.set(r.id, { ...r });

    // Faithful model of the reclaim UPDATE (the only statement issued). Written
    // as a plain (sql, params) async function and adapted to pg's overloaded
    // `Pool['query']` type via one localized cast; reclaimStaleProcessing only
    // ever calls the string-SQL-with-params overload modeled here.
    const queryImpl = async (
        sql: string,
        params?: unknown[],
    ): Promise<{ rows: never[]; rowCount: number }> => {
        if (
            /UPDATE poster_jobs/i.test(sql) &&
            /status = 'processing'/i.test(sql) &&
            /interval '1 second'/i.test(sql)
        ) {
            const timeoutSeconds = (params ?? [])[0] as number;
            // Cutoff mirrors `now() - ($1 * interval '1 second')`.
            const cutoffMs = nowMs - timeoutSeconds * 1000;

            let affected = 0;
            for (const r of store.values()) {
                // Reclaim iff processing AND updated_at STRICTLY before cutoff.
                if (r.status === 'processing' && r.updated_at_ms < cutoffMs) {
                    r.status = 'pending';
                    r.updated_at_ms = nowMs; // SET updated_at = now()
                    affected++;
                }
            }
            return { rows: [], rowCount: affected };
        }
        throw new Error(`Unexpected query in P13 model: ${sql}`);
    };

    return {
        query: queryImpl as unknown as Pool['query'],
        statusOf: (id) => store.get(id)?.status,
        updatedAtOf: (id) => store.get(id)?.updated_at_ms,
        rows: () => [...store.values()].map((r) => ({ ...r })),
    };
}

// --- fast-check generators ----------------------------------------------------

const NOW_MS = 1_700_000_000_000; // fixed reference "now" for the model.

// A single job. `ageSec` is how old its `updated_at` is relative to `now`
// (>= 0 seconds in the past). We spread ages across the timeout boundary so the
// generator naturally produces both stale (older than timeout) and fresh
// (within timeout) processing jobs.
const jobShapeArb = fc.record({
    media_id: fc.integer({ min: 1, max: 1_000_000 }),
    status: fc.constantFrom<JobStatus>(
        'processing',
        'processing',
        'processing',
        'pending',
        'done',
        'failed',
    ),
    attempts: fc.integer({ min: 0, max: 5 }),
    // How many seconds ago updated_at was stamped (0 == exactly now).
    ageSec: fc.integer({ min: 0, max: 7200 }),
    // run_after offset is irrelevant to reclaim but kept realistic.
    runAfterOffsetSec: fc.integer({ min: -3600, max: 3600 }),
});

const scenarioArb = fc
    .record({
        jobs: fc.array(jobShapeArb, { minLength: 0, maxLength: 40 }),
        timeoutSeconds: fc.integer({ min: 1, max: 3600 }),
    })
    .map(({ jobs, timeoutSeconds }) => ({
        seed: jobs.map((j, i): JobRow => ({
            id: i + 1,
            media_id: j.media_id,
            status: j.status,
            attempts: j.attempts,
            run_after_ms: NOW_MS + j.runAfterOffsetSec * 1000,
            updated_at_ms: NOW_MS - j.ageSec * 1000,
        })),
        timeoutSeconds,
    }));

const NUM_RUNS = 200;

describe('P13 — stale-processing jobs become reclaimable', () => {
    it('reclaims exactly the processing jobs older than the timeout, untouches the rest', async () => {
        await fc.assert(
            fc.asyncProperty(scenarioArb, async ({ seed, timeoutSeconds }) => {
                const model = createPosterJobsModel(seed, NOW_MS);
                const cutoffMs = NOW_MS - timeoutSeconds * 1000;

                // Classify each seeded job BEFORE reclaim.
                const shouldReclaim = new Set(
                    seed
                        .filter(
                            (r) =>
                                r.status === 'processing' && r.updated_at_ms < cutoffMs,
                        )
                        .map((r) => r.id),
                );

                const reclaimedCount = await reclaimStaleProcessing(
                    timeoutSeconds,
                    model,
                );

                // (a) COUNT: the helper returns exactly the number reclaimed.
                expect(reclaimedCount).toBe(shouldReclaim.size);

                const bySeedId = new Map(seed.map((r) => [r.id, r]));
                for (const now of model.rows()) {
                    const before = bySeedId.get(now.id)!;
                    if (shouldReclaim.has(now.id)) {
                        // (b) STALE processing -> pending, updated_at re-stamped.
                        expect(now.status).toBe('pending');
                        expect(now.updated_at_ms).toBe(NOW_MS);
                    } else {
                        // (c) UNTOUCHED: status and updated_at exactly preserved.
                        //     Covers fresh 'processing' (within timeout) AND every
                        //     non-processing job (pending/done/failed).
                        expect(now.status).toBe(before.status);
                        expect(now.updated_at_ms).toBe(before.updated_at_ms);
                    }
                }
            }),
            { numRuns: NUM_RUNS },
        );
    });

    it('a processing job within the timeout window is never reclaimed', async () => {
        // Focused generator: one processing job strictly newer than the timeout.
        const freshArb = fc
            .record({
                timeoutSeconds: fc.integer({ min: 2, max: 3600 }),
                // age strictly less than timeout => within the window.
            })
            .chain(({ timeoutSeconds }) =>
                fc.record({
                    timeoutSeconds: fc.constant(timeoutSeconds),
                    ageSec: fc.integer({ min: 0, max: timeoutSeconds - 1 }),
                }),
            );

        await fc.assert(
            fc.asyncProperty(freshArb, async ({ timeoutSeconds, ageSec }) => {
                const seed: JobRow[] = [
                    {
                        id: 1,
                        media_id: 1,
                        status: 'processing',
                        attempts: 0,
                        run_after_ms: NOW_MS,
                        updated_at_ms: NOW_MS - ageSec * 1000,
                    },
                ];
                const model = createPosterJobsModel(seed, NOW_MS);

                const reclaimedCount = await reclaimStaleProcessing(
                    timeoutSeconds,
                    model,
                );

                // Within the window (age < timeout): nothing reclaimed, job stays
                // processing with its original updated_at.
                expect(reclaimedCount).toBe(0);
                expect(model.statusOf(1)).toBe('processing');
                expect(model.updatedAtOf(1)).toBe(NOW_MS - ageSec * 1000);
            }),
            { numRuns: NUM_RUNS },
        );
    });

    it('a processing job older than the timeout is reclaimed to pending', async () => {
        // Focused generator: one processing job strictly older than the timeout.
        const staleArb = fc
            .record({
                timeoutSeconds: fc.integer({ min: 1, max: 3600 }),
                extraSec: fc.integer({ min: 1, max: 3600 }),
            })
            .map(({ timeoutSeconds, extraSec }) => ({
                timeoutSeconds,
                ageSec: timeoutSeconds + extraSec, // strictly older than timeout
            }));

        await fc.assert(
            fc.asyncProperty(staleArb, async ({ timeoutSeconds, ageSec }) => {
                const seed: JobRow[] = [
                    {
                        id: 1,
                        media_id: 1,
                        status: 'processing',
                        attempts: 2,
                        run_after_ms: NOW_MS,
                        updated_at_ms: NOW_MS - ageSec * 1000,
                    },
                ];
                const model = createPosterJobsModel(seed, NOW_MS);

                const reclaimedCount = await reclaimStaleProcessing(
                    timeoutSeconds,
                    model,
                );

                // Older than the window: reclaimed back to pending so a crashed
                // worker's stranded job becomes claimable again (Req 10.2, 10.3).
                expect(reclaimedCount).toBe(1);
                expect(model.statusOf(1)).toBe('pending');
                expect(model.updatedAtOf(1)).toBe(NOW_MS);
            }),
            { numRuns: NUM_RUNS },
        );
    });
});
