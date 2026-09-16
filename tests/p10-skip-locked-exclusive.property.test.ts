// Property test P10 — "SKIP LOCKED gives exclusive claims" — Task 7.2.
//
// Property 5 (design.md "Correctness Properties"):
//   For any set of due `pending` jobs and any number of concurrent workers each
//   claiming a batch, every job is claimed by at most one worker per poll cycle,
//   and every claimed job is transitioned to `processing`.
//   Validates: Requirements 7.1, 7.2, 7.5
//
// Modeling approach (mirrors the in-memory-reference style of P8/P9):
//   - The queue-claim contract of `poster_jobs` is modeled as an IN-MEMORY
//     reference model of the table. The ONLY SQL the real `claimJobs`
//     (worker/src/queue.ts) issues is the atomic:
//
//         UPDATE poster_jobs
//         SET status = 'processing', updated_at = now()
//         WHERE id IN (
//             SELECT id FROM poster_jobs
//             WHERE status = 'pending' AND run_after <= now()
//             ORDER BY run_after
//             FOR UPDATE SKIP LOCKED
//             LIMIT $1
//         )
//         RETURNING id, media_id, status, attempts, run_after
//
//     so a faithful model of that ONE statement is sufficient. The fake
//     executor implements exactly those semantics: pick due `pending` rows,
//     ORDER BY run_after, LIMIT to the batch size, flip them to `processing`,
//     and RETURN them. Rows already `processing` (claimed earlier this cycle by
//     a different concurrent claimer) are NOT re-selected — this is the analog
//     of `FOR UPDATE SKIP LOCKED` skipping already-locked rows so a given job is
//     claimed by at most one worker per poll cycle.
//
//   - The REAL `claimJobs` from worker/src/queue.ts runs against this fake
//     executor. `claimJobs` accepts an optional `Executor` (anything with a
//     matching `.query`), so we inject the model without touching a real DB and
//     without needing a live Postgres.
//
// CONCURRENCY MODEL: true OS-thread parallelism is not reproducible in a unit
// test, and Postgres already serializes the row-locking decision. What SKIP
// LOCKED guarantees observationally is: when N claimers each grab a batch over
// the same due set, no job is handed to two claimers, and every handed-out job
// is now `processing`. The reference model makes each claim's select+update
// step indivisible (a single synchronous pass, exactly like the atomic UPDATE
// statement), and we fire many claimers against it. Interleaving is modeled at
// the async-step level via Promise scheduling; because each `query` resolves its
// select+update synchronously before yielding, the model faithfully reproduces
// the "at most one claimer per row" invariant of the real statement.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { Pool } from 'pg';

import { claimJobs, type PosterJob } from '../worker/src/queue';

// --- In-memory poster_jobs reference model -----------------------------------

interface JobRow {
    id: number;
    media_id: number;
    status: 'pending' | 'processing' | 'done' | 'failed';
    attempts: number;
    // run_after as a millisecond epoch so we can compare against "now".
    run_after_ms: number;
}

interface PosterJobsModel {
    // Typed as pg's own Pool.query (its full overloaded signature) so the model
    // is assignable to the `Executor = Pick<Pool | PoolClient, 'query'>`
    // parameter of claimJobs under tsc. The single-string-SQL overload is the
    // only one the helper actually calls.
    query: Pool['query'];
    rows: () => JobRow[];
    statusOf: (id: number) => JobRow['status'] | undefined;
}

// `now` is fixed per model instance so `run_after <= now()` is deterministic.
function createPosterJobsModel(seed: JobRow[], nowMs: number): PosterJobsModel {
    // Clone so the model owns its mutable state.
    const store = new Map<number, JobRow>();
    for (const r of seed) store.set(r.id, { ...r });

    async function query(
        sql: string,
        params?: unknown[],
    ): Promise<{ rowCount: number; rows: PosterJob[] }> {
        if (/UPDATE poster_jobs/i.test(sql) && /SKIP LOCKED/i.test(sql)) {
            const limit = (params ?? [])[0] as number;

            // 1) SELECT id FROM poster_jobs
            //      WHERE status = 'pending' AND run_after <= now()
            //      ORDER BY run_after
            //      FOR UPDATE SKIP LOCKED
            //      LIMIT $1
            //
            // In a single indivisible pass we pick due pending rows. Rows that
            // are no longer `pending` (already flipped to `processing` by an
            // earlier claimer in this cycle) are skipped — the SKIP LOCKED
            // analog: at most one claimer per row.
            const due = [...store.values()]
                .filter((r) => r.status === 'pending' && r.run_after_ms <= nowMs)
                .sort((a, b) => a.run_after_ms - b.run_after_ms || a.id - b.id)
                .slice(0, Math.max(0, limit));

            // 2) UPDATE ... SET status = 'processing' for the chosen rows, then
            //    RETURNING them. This transition happens INSIDE the claim, so a
            //    returned (claimed) row is always `processing` (Req 7.2).
            const claimed: PosterJob[] = [];
            for (const r of due) {
                r.status = 'processing';
                claimed.push({
                    id: r.id,
                    media_id: r.media_id,
                    status: r.status,
                    attempts: r.attempts,
                    run_after: new Date(r.run_after_ms).toISOString(),
                });
            }
            return { rowCount: claimed.length, rows: claimed };
        }
        throw new Error(`Unexpected query in P10 model: ${sql}`);
    }

    return {
        // One localized cast adapts the plain (sql, params) implementation to
        // pg's overloaded Pool['query'] type (mirrors how a real pg client
        // satisfies its many overloads with a single body).
        query: query as unknown as Pool['query'],
        rows: () => [...store.values()].map((r) => ({ ...r })),
        statusOf: (id: number) => store.get(id)?.status,
    };
}

// --- fast-check generators ----------------------------------------------------

const NOW_MS = 1_700_000_000_000; // fixed reference "now" for the model.

// A single job: unique id assigned later; here we generate its status-relevant
// shape. We generate a mix of due/pending, future/pending, and non-pending
// (done/failed/processing) jobs to prove only DUE PENDING jobs are ever claimed.
const jobShapeArb = fc.record({
    media_id: fc.integer({ min: 1, max: 1_000_000 }),
    // Relative run_after: negative => due (past), positive => not yet due.
    runAfterOffsetSec: fc.integer({ min: -3600, max: 3600 }),
    status: fc.constantFrom<'pending' | 'processing' | 'done' | 'failed'>(
        'pending',
        'pending',
        'pending',
        'processing',
        'done',
        'failed',
    ),
    attempts: fc.integer({ min: 0, max: 5 }),
});

// A set of jobs (assign sequential unique ids), plus a set of concurrent
// claimers each with its own batch limit.
const scenarioArb = fc
    .record({
        jobs: fc.array(jobShapeArb, { minLength: 0, maxLength: 40 }),
        // Each entry is one concurrent claimer's batch size (>= 1).
        claimerLimits: fc.array(fc.integer({ min: 1, max: 15 }), {
            minLength: 1,
            maxLength: 8,
        }),
    })
    .map(({ jobs, claimerLimits }) => ({
        seed: jobs.map((j, i): JobRow => ({
            id: i + 1,
            media_id: j.media_id,
            status: j.status,
            attempts: j.attempts,
            run_after_ms: NOW_MS + j.runAfterOffsetSec * 1000,
        })),
        claimerLimits,
    }));

const NUM_RUNS = 200;

describe('P10 — SKIP LOCKED gives exclusive claims', () => {
    it('concurrent claimers get DISJOINT claims and every claimed job is processing', async () => {
        await fc.assert(
            fc.asyncProperty(scenarioArb, async ({ seed, claimerLimits }) => {
                const model = createPosterJobsModel(seed, NOW_MS);

                // The set of jobs that are ELIGIBLE to be claimed this cycle:
                // due (run_after <= now) AND pending. Nothing else may be claimed.
                const eligibleIds = new Set(
                    seed
                        .filter((r) => r.status === 'pending' && r.run_after_ms <= NOW_MS)
                        .map((r) => r.id),
                );

                // Fire all claimers "concurrently": build the promises without
                // awaiting between them, then await together. Each claimJobs runs
                // the atomic claim against the shared model.
                const batches = await Promise.all(
                    claimerLimits.map((limit) => claimJobs(limit, model)),
                );

                // (a) EXCLUSIVITY / DISJOINTNESS: no job id appears in more than
                //     one claimer's batch (at most one worker per job per cycle).
                const seen = new Set<number>();
                for (const batch of batches) {
                    for (const job of batch) {
                        expect(seen.has(job.id)).toBe(false);
                        seen.add(job.id);
                    }
                }

                // (b) TRANSITION: every claimed job was returned as 'processing'
                //     AND is 'processing' in the model afterwards (Req 7.2).
                for (const batch of batches) {
                    for (const job of batch) {
                        expect(job.status).toBe('processing');
                        expect(model.statusOf(job.id)).toBe('processing');
                    }
                }

                // (c) ONLY-ELIGIBLE: every claimed job was a due pending job.
                //     No future-dated, done, failed, or already-processing job is
                //     ever claimed (Req 7.1).
                for (const id of seen) {
                    expect(eligibleIds.has(id)).toBe(true);
                }

                // (d) NO PHANTOM TRANSITIONS: any job NOT claimed keeps its
                //     original status (ineligible jobs are untouched; eligible
                //     jobs left unclaimed due to capacity stay 'pending').
                const finalById = new Map(model.rows().map((r) => [r.id, r]));
                for (const orig of seed) {
                    const now = finalById.get(orig.id)!;
                    if (seen.has(orig.id)) {
                        expect(now.status).toBe('processing');
                    } else {
                        expect(now.status).toBe(orig.status);
                    }
                }
            }),
            { numRuns: NUM_RUNS },
        );
    });

    it('total claimed count never exceeds the number of eligible due pending jobs', async () => {
        await fc.assert(
            fc.asyncProperty(scenarioArb, async ({ seed, claimerLimits }) => {
                const model = createPosterJobsModel(seed, NOW_MS);

                const eligibleCount = seed.filter(
                    (r) => r.status === 'pending' && r.run_after_ms <= NOW_MS,
                ).length;

                const batches = await Promise.all(
                    claimerLimits.map((limit) => claimJobs(limit, model)),
                );
                const totalClaimed = batches.reduce((n, b) => n + b.length, 0);

                // Concurrent claimers collectively claim no more than the eligible
                // set — SKIP LOCKED cannot conjure duplicate claims (Req 7.5).
                expect(totalClaimed).toBeLessThanOrEqual(eligibleCount);

                // And no duplicates across all batches, so the count of DISTINCT
                // claimed ids equals the total claimed count.
                const distinct = new Set(batches.flat().map((j) => j.id));
                expect(distinct.size).toBe(totalClaimed);
            }),
            { numRuns: NUM_RUNS },
        );
    });
});
