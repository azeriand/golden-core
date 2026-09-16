// Unit tests for failJob backoff ordering — Task 7.6.
// worker/src/queue.ts `failJob`
//
// Focus: CONCRETE, example-based verification (not a property test) of the two
// observable behaviours of the failJob UPDATE:
//
//   1. Backoff ORDERING — for a fixed base, consecutive retry failures schedule
//      run_after at base * 2^attempts seconds into the future, producing a
//      strictly increasing (well-ordered) delay sequence. With base = 5 and
//      pre-increment attempts 0, 1, 2 the delays are exactly 5, 10, 20 seconds.
//   2. The `failed` transition happens EXACTLY when attempts + 1 == Max_Attempts
//      — one failure earlier the job is still 'pending' (retryable); at the
//      boundary it becomes 'failed' and run_after is left unchanged.
//
// The failJob SQL (worker/src/queue.ts) is:
//
//   UPDATE poster_jobs
//   SET attempts = attempts + 1,
//       status = CASE WHEN attempts + 1 >= $2 THEN 'failed' ELSE 'pending' END,
//       run_after = CASE WHEN attempts + 1 >= $2
//                        THEN run_after
//                        ELSE now() + ($3 * power(2, attempts)) * interval '1 second'
//                   END,
//       updated_at = now()
//   WHERE id = $1;
//
// We drive the REAL `failJob` helper against a small fake pg executor that
// INTERPRETS exactly this one statement against an in-memory row keyed by id,
// capturing the `now()` used per query so we can assert absolute run_after
// values. This mirrors the test-double style of tests/poster-jobs.test.ts and
// the in-memory model of the P11/P12 property tests, but with fixed, concrete
// inputs rather than generated ones.
//
// Covered acceptance criteria:
//   Req 9.1 — every failure increments attempts by exactly one.
//   Req 9.2 — below Max_Attempts, status returns to 'pending' with a future
//             run_after computed by the backoff.
//   Req 9.3 — the backoff delay increases as attempts grows (concrete ordering
//             5 < 10 < 20 seconds).
//   Req 9.4 — at Max_Attempts the status becomes 'failed'.
import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { failJob } from '@/worker/src/queue';

interface JobRow {
    id: number;
    media_id: number;
    status: 'pending' | 'processing' | 'done' | 'failed';
    attempts: number;
    run_after: number; // epoch ms (models timestamptz)
    updated_at: number; // epoch ms
}

// A minimal, faithful test double of the failJob UPDATE ... contract. It keeps
// one row per id and mirrors the SQL exactly: increment attempts, then either
// mark 'failed' (leaving run_after) or return to 'pending' with a backoff
// run_after of now + base * 2^(pre-increment attempts) seconds. It also records
// the `now()` value used for each query so tests can assert absolute schedules.
//
// The fake is cast to `Pool` via `as unknown as Pool` (the same escape hatch
// used in tests/poster-jobs.test.ts) so it satisfies the queue helper's
// `Executor = Pick<Pool | PoolClient, 'query'>` parameter without wrestling with
// pg's overloaded generic `query` signature. failJob only ever runs the one
// UPDATE, so a single SQL branch is enough; any other SQL is a test bug.
function fakeFailJobExecutor(initial: JobRow): {
    pool: Pool;
    get: () => JobRow;
    lastNow: () => number;
} {
    const row: JobRow = { ...initial };
    let lastNow = 0;

    const query = async (sql: string, values?: unknown[]) => {
        if (!/UPDATE poster_jobs/i.test(sql) || !/attempts = attempts \+ 1/i.test(sql)) {
            throw new Error(`Unexpected query in failjob-backoff test: ${sql}`);
        }
        const id = (values ?? [])[0] as number;
        const maxAttempts = (values ?? [])[1] as number;
        const backoffBaseSeconds = (values ?? [])[2] as number;

        // Capture now() at evaluation time, exactly as the DB stamps it.
        const now = Date.now();
        lastNow = now;

        if (row.id !== id) {
            return { rows: [], rowCount: 0 };
        }

        const preAttempts = row.attempts;
        const nextAttempts = preAttempts + 1; // attempts = attempts + 1 (Req 9.1)
        row.attempts = nextAttempts;

        if (nextAttempts >= maxAttempts) {
            // Terminal: status = 'failed', run_after UNCHANGED (Req 9.4).
            row.status = 'failed';
        } else {
            // Retry: status = 'pending', run_after = now + base * 2^attempts s.
            row.status = 'pending';
            row.run_after = now + backoffBaseSeconds * Math.pow(2, preAttempts) * 1000;
        }
        row.updated_at = now;
        return { rows: [], rowCount: 1 };
    };

    const pool = { query } as unknown as Pool;
    return { pool, get: () => row, lastNow: () => lastNow };
}

describe('failJob — concrete backoff ordering (Req 9.1, 9.2, 9.3)', () => {
    it('base=5, attempts 0/1/2 produce run_after delays of 5, 10, 20 seconds (strictly increasing)', async () => {
        const base = 5;
        const maxAttempts = 100; // large so every failure lands on the retry branch

        // Three independent jobs seeded at pre-increment attempts 0, 1, 2 so each
        // failure exercises exactly one point on the backoff curve.
        const cases = [
            { attempts: 0, expectedSeconds: 5 }, // 5 * 2^0
            { attempts: 1, expectedSeconds: 10 }, // 5 * 2^1
            { attempts: 2, expectedSeconds: 20 }, // 5 * 2^2
        ];

        const delays: number[] = [];
        for (const c of cases) {
            const db = fakeFailJobExecutor({
                id: 1,
                media_id: 1,
                status: 'processing',
                attempts: c.attempts,
                run_after: 0,
                updated_at: 0,
            });

            await failJob(1, c.attempts, maxAttempts, base, db.pool);

            const row = db.get();
            const now = db.lastNow();

            // Below Max_Attempts => retryable (Req 9.2) and attempts incremented (Req 9.1).
            expect(row.status).toBe('pending');
            expect(row.attempts).toBe(c.attempts + 1);

            // run_after is exactly now + expected backoff, strictly in the future (Req 9.2).
            const delayMs = row.run_after - now;
            expect(delayMs).toBe(c.expectedSeconds * 1000);
            expect(row.run_after).toBeGreaterThan(now);

            delays.push(delayMs);
        }

        // Concrete ordering: 5s < 10s < 20s — delays strictly increase (Req 9.3).
        expect(delays).toEqual([5000, 10000, 20000]);
        expect(delays[0]).toBeLessThan(delays[1]!);
        expect(delays[1]).toBeLessThan(delays[2]!);
    });

    it('a full retry sequence from attempts=0 yields ordered 5, 10, 20, 40 second delays', async () => {
        const base = 5;
        const maxAttempts = 100; // never terminal within this sequence
        const db = fakeFailJobExecutor({
            id: 42,
            media_id: 7,
            status: 'processing',
            attempts: 0,
            run_after: 0,
            updated_at: 0,
        });

        const delays: number[] = [];
        for (let i = 0; i < 4; i++) {
            const attemptsBefore = db.get().attempts;
            await failJob(42, attemptsBefore, maxAttempts, base, db.pool);
            const row = db.get();
            expect(row.status).toBe('pending');
            delays.push(row.run_after - db.lastNow());
        }

        // Exponential backoff, strictly ordered increasing.
        expect(delays).toEqual([5000, 10000, 20000, 40000]);
        for (let i = 1; i < delays.length; i++) {
            expect(delays[i]!).toBeGreaterThan(delays[i - 1]!);
        }
    });
});

describe('failJob — failed transition exactly at Max_Attempts (Req 9.1, 9.4)', () => {
    it('with Max_Attempts=3, failures go pending, pending, then failed on the third', async () => {
        const maxAttempts = 3;
        const base = 5;
        const db = fakeFailJobExecutor({
            id: 9,
            media_id: 9,
            status: 'processing',
            attempts: 0,
            run_after: 0,
            updated_at: 0,
        });

        // 1st failure: attempts 0 -> 1, 1 < 3 => pending.
        await failJob(9, 0, maxAttempts, base, db.pool);
        expect(db.get().attempts).toBe(1);
        expect(db.get().status).toBe('pending');

        // 2nd failure: attempts 1 -> 2, 2 < 3 => pending.
        await failJob(9, 1, maxAttempts, base, db.pool);
        expect(db.get().attempts).toBe(2);
        expect(db.get().status).toBe('pending');

        // 3rd failure: attempts 2 -> 3, 3 >= 3 => failed EXACTLY at Max_Attempts (Req 9.4).
        await failJob(9, 2, maxAttempts, base, db.pool);
        expect(db.get().attempts).toBe(3);
        expect(db.get().status).toBe('failed');
    });

    it('the terminal failure leaves run_after unchanged (no misleading future schedule)', async () => {
        const maxAttempts = 1; // the very first failure is terminal (0 + 1 >= 1)
        const base = 5;
        const originalRunAfter = 123_456;
        const db = fakeFailJobExecutor({
            id: 5,
            media_id: 5,
            status: 'processing',
            attempts: 0,
            run_after: originalRunAfter,
            updated_at: 0,
        });

        await failJob(5, 0, maxAttempts, base, db.pool);

        const row = db.get();
        expect(row.status).toBe('failed');
        expect(row.attempts).toBe(1);
        // run_after is left exactly as it was — the terminal branch does not
        // schedule a retry (Req 9.4).
        expect(row.run_after).toBe(originalRunAfter);
    });

    it('boundary check: with Max_Attempts=2, the second failure is the failed transition', async () => {
        const maxAttempts = 2;
        const base = 5;
        const db = fakeFailJobExecutor({
            id: 2,
            media_id: 2,
            status: 'processing',
            attempts: 0,
            run_after: 0,
            updated_at: 0,
        });

        // attempts 0 -> 1, 1 < 2 => still retryable.
        await failJob(2, 0, maxAttempts, base, db.pool);
        expect(db.get().status).toBe('pending');
        expect(db.get().attempts).toBe(1);

        // attempts 1 -> 2, 2 >= 2 => failed exactly at the boundary.
        await failJob(2, 1, maxAttempts, base, db.pool);
        expect(db.get().status).toBe('failed');
        expect(db.get().attempts).toBe(2);
    });
});
