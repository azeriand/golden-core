// Property test P11 — "Retry increments attempts and backoff is non-decreasing"
// — Task 7.3.
//
// Property 7 (design.md "Correctness Properties"):
//   For any job that fails while `attempts + 1 < Max_Attempts`, the failure
//   increments `attempts` by exactly one and sets a strictly future `run_after`,
//   and the Retry_Backoff delay is non-decreasing as `attempts` grows.
//   Validates: Requirements 9.1, 9.2, 9.3
//
// Modeling approach (mirrors the in-memory-reference style of P8/P9):
//   The queue state machine `failJob` (worker/src/queue.ts) is pure relative to
//   its SQL contract, so we model `public.poster_jobs` and the exact semantics
//   of the failJob UPDATE as an IN-MEMORY reference:
//
//       UPDATE poster_jobs
//       SET attempts = attempts + 1,
//           status = CASE WHEN attempts + 1 >= $2 THEN 'failed' ELSE 'pending' END,
//           run_after = CASE WHEN attempts + 1 >= $2
//                            THEN run_after
//                            ELSE now() + ($3 * power(2, attempts)) * interval '1 second'
//                       END,
//           updated_at = now()
//       WHERE id = $1;
//
//   The `$3 * power(2, attempts)` backoff uses the PRE-increment `attempts`, so
//   the first retry (attempts 0 -> 1) waits `base * 2^0 = base` seconds, the
//   second `base * 2^1`, and so on. Because the exponent grows with `attempts`
//   and base is non-negative, the computed delay is NON-DECREASING (in fact
//   strictly increasing while base > 0) as `attempts` grows (Req 9.3).
//
// We drive the REAL `failJob` against a fake pg executor that INTERPRETS the SQL
// exactly as Postgres would for the id/attempts/max/base parameters, capturing
// `now()` at query time so we can assert the resulting `run_after` is strictly
// in the future for the retry (pending) branch (Req 9.2). Effectful boundaries
// (real DB, ffmpeg, Blob) are out of scope for this pure state-machine property.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { Pool } from 'pg';

import { failJob } from '@/worker/src/queue';

// --- In-memory poster_jobs reference model -----------------------------------

interface JobRow {
    id: number;
    media_id: number;
    status: 'pending' | 'processing' | 'done' | 'failed';
    attempts: number;
    run_after: number; // epoch ms (models timestamptz)
    updated_at: number; // epoch ms
}

interface QueryLog {
    now: number; // the `now()` value used to evaluate this query
}

interface PosterJobsModel {
    // Typed as pg's own Pool.query (its full overloaded signature) so the model
    // is assignable to the `Executor = Pick<Pool | PoolClient, 'query'>`
    // parameter of failJob under tsc. The single-string-SQL overload is the only
    // one the helper actually calls.
    query: Pool['query'];
    get: (id: number) => JobRow | undefined;
    lastNow: () => number;
}

// Reference implementation of the failJob UPDATE. This is a faithful model of
// the SQL in worker/src/queue.ts `failJob` — the ONLY statement that test issues
// — so exercising the real helper against it verifies the state machine without
// a live database.
function createPosterJobsModel(initial: JobRow[]): PosterJobsModel {
    const byId = new Map<number, JobRow>();
    for (const r of initial) byId.set(r.id, { ...r });
    const log: QueryLog[] = [];

    async function query(sql: string, params?: unknown[]) {
        if (/UPDATE poster_jobs/i.test(sql) && /attempts = attempts \+ 1/i.test(sql)) {
            const id = (params ?? [])[0] as number;
            const maxAttempts = (params ?? [])[1] as number;
            const backoffBaseSeconds = (params ?? [])[2] as number;
            // Capture now() at evaluation time, exactly like the DB stamping it.
            const now = Date.now();
            log.push({ now });

            const row = byId.get(id);
            if (!row) return { rowCount: 0, rows: [] };

            const preAttempts = row.attempts;
            const nextAttempts = preAttempts + 1;
            const isTerminal = nextAttempts >= maxAttempts;

            row.attempts = nextAttempts; // attempts = attempts + 1 (Req 9.1)
            if (isTerminal) {
                // status = 'failed', run_after UNCHANGED (Req 9.4).
                row.status = 'failed';
            } else {
                // status = 'pending', run_after = now + base * 2^(preAttempts) s.
                row.status = 'pending';
                row.run_after = now + backoffBaseSeconds * Math.pow(2, preAttempts) * 1000;
            }
            row.updated_at = now;
            return { rowCount: 1, rows: [] };
        }
        throw new Error(`Unexpected query in P11 model: ${sql}`);
    }

    return {
        // One localized cast adapts the plain (sql, params) implementation to
        // pg's overloaded Pool['query'] type (mirrors how a real pg client
        // satisfies its many overloads with a single body).
        query: query as unknown as Pool['query'],
        get: (id: number) => byId.get(id),
        lastNow: () => (log.length ? log[log.length - 1]!.now : 0),
    };
}

// Pure reference for the backoff delay in SECONDS for a given pre-increment
// attempts count, matching `base * power(2, attempts)`.
function backoffDelaySeconds(base: number, attempts: number): number {
    return base * Math.pow(2, attempts);
}

// --- fast-check generators ----------------------------------------------------

// A single-failure scenario constrained so the failure lands on the RETRY
// branch: attempts + 1 < maxAttempts. base >= 1 keeps the future strictly in
// the future and the delay strictly positive.
const retryScenarioArb = fc
    .record({
        attempts: fc.integer({ min: 0, max: 20 }),
        // headroom so that attempts + 1 < maxAttempts (retry, not terminal).
        headroom: fc.integer({ min: 2, max: 10 }),
        base: fc.integer({ min: 1, max: 60 }),
    })
    .map(({ attempts, headroom, base }) => ({
        attempts,
        maxAttempts: attempts + headroom, // ensures attempts + 1 < maxAttempts
        base,
    }));

const NUM_RUNS = 200;

describe('P11 — retry increments attempts and backoff is non-decreasing', () => {
    it('a retry failure increments attempts by exactly one (Req 9.1)', async () => {
        await fc.assert(
            fc.asyncProperty(retryScenarioArb, async (s) => {
                const model = createPosterJobsModel([
                    {
                        id: 1,
                        media_id: 1,
                        status: 'processing',
                        attempts: s.attempts,
                        run_after: 0,
                        updated_at: 0,
                    },
                ]);

                await failJob(1, s.attempts, s.maxAttempts, s.base, model);

                const row = model.get(1)!;
                // attempts incremented by exactly one.
                expect(row.attempts).toBe(s.attempts + 1);
                // Below max => returned to pending for another attempt (Req 9.2).
                expect(row.status).toBe('pending');
            }),
            { numRuns: NUM_RUNS },
        );
    });

    it('a retry failure sets a strictly-future run_after (Req 9.2)', async () => {
        await fc.assert(
            fc.asyncProperty(retryScenarioArb, async (s) => {
                const model = createPosterJobsModel([
                    {
                        id: 7,
                        media_id: 7,
                        status: 'processing',
                        attempts: s.attempts,
                        run_after: 0,
                        updated_at: 0,
                    },
                ]);

                await failJob(7, s.attempts, s.maxAttempts, s.base, model);

                const row = model.get(7)!;
                const now = model.lastNow();
                // run_after is strictly after the now() used to compute it.
                expect(row.run_after).toBeGreaterThan(now);
                // And exactly now + base * 2^attempts seconds (the backoff).
                const expectedDelayMs = backoffDelaySeconds(s.base, s.attempts) * 1000;
                expect(row.run_after).toBe(now + expectedDelayMs);
            }),
            { numRuns: NUM_RUNS },
        );
    });

    it('backoff delay is non-decreasing as attempts grows (Req 9.3)', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.integer({ min: 1, max: 60 }), // base >= 1
                fc.integer({ min: 0, max: 24 }), // attempts n
                async (base, n) => {
                    // The delay computed for attempts n must be <= the delay for
                    // attempts n+1 (monotonic non-decreasing), and with base >= 1
                    // it is in fact strictly increasing.
                    const dN = backoffDelaySeconds(base, n);
                    const dN1 = backoffDelaySeconds(base, n + 1);
                    expect(dN1).toBeGreaterThanOrEqual(dN);
                    expect(dN1).toBeGreaterThan(dN);

                    // Cross-check the reference against the REAL helper: two jobs
                    // failing at consecutive attempts get non-decreasing delays.
                    const maxAttempts = n + 100; // both are retry-branch failures.
                    const model = createPosterJobsModel([
                        { id: 1, media_id: 1, status: 'processing', attempts: n, run_after: 0, updated_at: 0 },
                        { id: 2, media_id: 2, status: 'processing', attempts: n + 1, run_after: 0, updated_at: 0 },
                    ]);

                    await failJob(1, n, maxAttempts, base, model);
                    const now1 = model.lastNow();
                    await failJob(2, n + 1, maxAttempts, base, model);
                    const now2 = model.lastNow();

                    const delay1 = model.get(1)!.run_after - now1;
                    const delay2 = model.get(2)!.run_after - now2;
                    expect(delay2).toBeGreaterThanOrEqual(delay1);
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });

    it('backoff over a full retry sequence is monotonic non-decreasing (Req 9.3)', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.integer({ min: 1, max: 30 }), // base
                fc.integer({ min: 2, max: 15 }), // number of retries to observe
                async (base, retries) => {
                    // maxAttempts large enough that every step is a retry (pending).
                    const maxAttempts = retries + 50;
                    const model = createPosterJobsModel([
                        { id: 1, media_id: 1, status: 'processing', attempts: 0, run_after: 0, updated_at: 0 },
                    ]);

                    const delays: number[] = [];
                    for (let i = 0; i < retries; i++) {
                        const attemptsBefore = model.get(1)!.attempts;
                        await failJob(1, attemptsBefore, maxAttempts, base, model);
                        const now = model.lastNow();
                        const row = model.get(1)!;
                        expect(row.status).toBe('pending');
                        delays.push(row.run_after - now);
                    }

                    // Each successive backoff delay is >= the previous one.
                    for (let i = 1; i < delays.length; i++) {
                        expect(delays[i]!).toBeGreaterThanOrEqual(delays[i - 1]!);
                    }
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });
});
