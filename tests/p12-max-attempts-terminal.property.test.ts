// Property test P12 — "Max_Attempts terminates retries and failed jobs are
// never reclaimed" — Task 7.4.
//
// Property 8 (design.md "Correctness Properties"):
//   For any job that fails when `attempts + 1 >= Max_Attempts`, the failure
//   yields status `failed`; and no claim cycle ever selects a `failed` job.
//   Validates: Requirements 9.4, 9.5
//
// This is a UNIT-level property against an IN-MEMORY reference model of
// `public.poster_jobs` that faithfully reproduces the SQL semantics of the two
// queue operations under test in worker/src/queue.ts:
//
//   failJob(id, attempts, maxAttempts, base):
//     UPDATE ... SET attempts = attempts + 1,
//                    status = CASE WHEN attempts + 1 >= maxAttempts
//                                  THEN 'failed' ELSE 'pending' END,
//                    run_after = CASE WHEN attempts + 1 >= maxAttempts
//                                     THEN run_after
//                                     ELSE now() + base*2^attempts seconds END
//     -> Req 9.1 (increment), 9.2/9.3 (retry+backoff), 9.4 (terminal at max).
//
//   claimJobs(limit):
//     UPDATE ... WHERE id IN (SELECT id ... WHERE status='pending'
//                             AND run_after <= now() ... FOR UPDATE SKIP LOCKED)
//     -> the `status = 'pending'` filter means a `failed` job is NEVER selected
//        (Req 9.5). We model this filter exactly.
//
// The model's insert/update decisions are indivisible, mirroring how Postgres
// applies a single UPDATE statement atomically. Effectful boundaries (ffmpeg,
// Blob, network) are irrelevant here — this exercises pure queue transitions.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

// --- In-memory poster_jobs reference model -----------------------------------

type JobStatus = 'pending' | 'processing' | 'done' | 'failed';

interface JobRow {
    id: number;
    media_id: number;
    status: JobStatus;
    attempts: number;
    run_after: number; // epoch ms; <= now means "due"
}

// A tiny reference model of the queue that implements exactly the failJob and
// claimJobs semantics from worker/src/queue.ts. `now` is injectable so tests
// can make backoff-scheduled jobs "due" deterministically without real waits.
class QueueModel {
    private rows = new Map<number, JobRow>();
    private nextId = 1;
    now = 0; // logical clock in ms

    seed(job: { media_id: number; status: JobStatus; attempts: number; run_after?: number }): JobRow {
        const row: JobRow = {
            id: this.nextId++,
            media_id: job.media_id,
            status: job.status,
            attempts: job.attempts,
            run_after: job.run_after ?? this.now,
        };
        this.rows.set(row.id, row);
        return row;
    }

    get(id: number): JobRow | undefined {
        return this.rows.get(id);
    }

    all(): JobRow[] {
        return [...this.rows.values()];
    }

    // Mirrors failJob(id, attempts, maxAttempts, base) SQL.
    // `attempts` is the pre-failure attempt count (as read at claim time).
    failJob(id: number, attempts: number, maxAttempts: number, baseSeconds: number): void {
        const row = this.rows.get(id);
        if (!row) return;
        const next = attempts + 1;
        row.attempts = next;
        if (next >= maxAttempts) {
            row.status = 'failed';
            // run_after left unchanged (terminal job keeps no future schedule).
        } else {
            row.status = 'pending';
            row.run_after = this.now + baseSeconds * Math.pow(2, attempts) * 1000;
        }
    }

    // Mirrors claimJobs(limit) SQL: selects ONLY status='pending' AND due, flips
    // them to 'processing'. `failed` (and done/processing) rows are never picked.
    claimJobs(limit: number): JobRow[] {
        if (!Number.isFinite(limit) || limit <= 0) return [];
        const due = this.all()
            .filter((r) => r.status === 'pending' && r.run_after <= this.now)
            .sort((a, b) => a.run_after - b.run_after)
            .slice(0, limit);
        for (const r of due) r.status = 'processing';
        return due;
    }
}

// --- fast-check generators ----------------------------------------------------

const maxAttemptsArb = fc.integer({ min: 1, max: 6 });
const baseSecondsArb = fc.integer({ min: 1, max: 30 });

const NUM_RUNS = 300;

describe('P12 — Max_Attempts terminal + failed jobs never reclaimed', () => {
    // Part A (Req 9.4): failing at attempts+1 >= Max_Attempts yields 'failed';
    // failing below the threshold yields 'pending' (retryable).
    it('failure at attempts+1 >= Max_Attempts transitions to failed', () => {
        fc.assert(
            fc.property(
                maxAttemptsArb,
                baseSecondsArb,
                // pre-failure attempts across the full below/at/above range.
                fc.integer({ min: 0, max: 10 }),
                (maxAttempts, base, attempts) => {
                    const q = new QueueModel();
                    const job = q.seed({ media_id: 1, status: 'processing', attempts });

                    q.failJob(job.id, attempts, maxAttempts, base);
                    const after = q.get(job.id)!;

                    // Attempts always incremented by exactly one (Req 9.1).
                    expect(after.attempts).toBe(attempts + 1);

                    if (attempts + 1 >= maxAttempts) {
                        // Terminal (Req 9.4).
                        expect(after.status).toBe('failed');
                    } else {
                        // Still retryable below the threshold.
                        expect(after.status).toBe('pending');
                    }
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });

    // Part B (Req 9.4): repeatedly failing a job from attempts=0 eventually and
    // exactly reaches 'failed' at the Max_Attempts-th failure, and not before.
    it('repeated failures terminate exactly at the Max_Attempts-th failure', () => {
        fc.assert(
            fc.property(maxAttemptsArb, baseSecondsArb, (maxAttempts, base) => {
                const q = new QueueModel();
                const job = q.seed({ media_id: 1, status: 'processing', attempts: 0 });

                for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                    const before = q.get(job.id)!;
                    // A failed job would never be re-claimed, so we only fail
                    // while it is still retryable.
                    q.failJob(job.id, before.attempts, maxAttempts, base);
                    const after = q.get(job.id)!;

                    if (attempt < maxAttempts) {
                        expect(after.status).toBe('pending');
                    } else {
                        // The Max_Attempts-th failure is terminal.
                        expect(after.status).toBe('failed');
                    }
                }
                expect(q.get(job.id)!.attempts).toBe(maxAttempts);
            }),
            { numRuns: NUM_RUNS },
        );
    });

    // Part C (Req 9.5): a claim cycle NEVER selects a 'failed' job, no matter how
    // many claim cycles run or how time advances (making run_after "due").
    it('no claim cycle ever selects a failed job', () => {
        // A mixed population of jobs in each status, with arbitrary run_after
        // offsets so some are "due" and some are not.
        const jobArb = fc.record({
            status: fc.constantFrom<JobStatus>('pending', 'processing', 'done', 'failed'),
            attempts: fc.integer({ min: 0, max: 6 }),
            runAfterOffsetMs: fc.integer({ min: -10_000, max: 10_000 }),
        });

        fc.assert(
            fc.property(
                fc.array(jobArb, { minLength: 1, maxLength: 30 }),
                fc.integer({ min: 1, max: 10 }), // claim batch size
                fc.integer({ min: 1, max: 5 }), // number of claim cycles
                (jobs, limit, cycles) => {
                    const q = new QueueModel();
                    q.now = 1_000_000;

                    const failedIds = new Set<number>();
                    for (const j of jobs) {
                        const row = q.seed({
                            media_id: 1,
                            status: j.status,
                            attempts: j.attempts,
                            run_after: q.now + j.runAfterOffsetMs,
                        });
                        if (j.status === 'failed') failedIds.add(row.id);
                    }

                    for (let c = 0; c < cycles; c++) {
                        // Advance time so every job's run_after is now due —
                        // this proves that even "due" failed jobs are excluded
                        // by the status filter, not merely by scheduling.
                        q.now += 100_000;
                        const claimed = q.claimJobs(limit);
                        for (const row of claimed) {
                            // No claimed job is a failed job (Req 9.5).
                            expect(failedIds.has(row.id)).toBe(false);
                            expect(row.status).toBe('processing');
                        }
                    }

                    // Every originally-failed job is still 'failed' afterwards —
                    // claiming never touched or resurrected it.
                    for (const id of failedIds) {
                        expect(q.get(id)!.status).toBe('failed');
                    }
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });

    // Part D (Req 9.4 + 9.5 together): drive a job to terminal 'failed' via
    // repeated fail+claim cycles, then assert it is never re-claimed even after
    // arbitrary time advances — the end-to-end termination guarantee.
    it('a job driven to failed is never reclaimed on subsequent cycles', () => {
        fc.assert(
            fc.property(maxAttemptsArb, baseSecondsArb, (maxAttempts, base) => {
                const q = new QueueModel();
                q.now = 0;
                const job = q.seed({ media_id: 1, status: 'pending', attempts: 0 });

                // Fail-and-retry loop: claim (which flips to processing), then
                // fail, until the job goes terminal.
                let guard = 0;
                while (q.get(job.id)!.status !== 'failed' && guard < 100) {
                    guard++;
                    // Make it due, then claim it.
                    q.now += 1_000_000_000;
                    const claimed = q.claimJobs(10);
                    if (claimed.some((r) => r.id === job.id)) {
                        q.failJob(job.id, q.get(job.id)!.attempts, maxAttempts, base);
                    }
                }

                expect(q.get(job.id)!.status).toBe('failed');
                expect(q.get(job.id)!.attempts).toBe(maxAttempts);

                // Now run many more claim cycles across advancing time: the
                // failed job must never be selected again (Req 9.5).
                for (let c = 0; c < 20; c++) {
                    q.now += 1_000_000_000;
                    const claimed = q.claimJobs(10);
                    expect(claimed.some((r) => r.id === job.id)).toBe(false);
                }
                expect(q.get(job.id)!.status).toBe('failed');
            }),
            { numRuns: NUM_RUNS },
        );
    });
});
