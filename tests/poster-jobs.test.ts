// Unit tests for the idempotent poster-job enqueue helper — Task 2.4.
// lib/poster-jobs.ts
//
// Focus: the no-op-on-conflict contract of `enqueuePosterJob`. The first
// enqueue for a media_id inserts a row (returns true); a second enqueue for the
// SAME media_id is a no-op via `ON CONFLICT (media_id) DO NOTHING` (returns
// false) and creates no duplicate job.
//
// We use a small test-double pg executor (matching the `poolWithRows` style in
// section-match.test.ts) that models `INSERT ... ON CONFLICT (media_id) DO
// NOTHING` against an in-memory table keyed by media_id. It reports
// `rowCount = 1` on a real insert and `rowCount = 0` on a conflict — exactly the
// signal the helper reads. No production code is refactored for testability.
//
// Covered acceptance criteria:
//   Req 5.1 — enqueue for an existing media_id leaves the existing job unchanged
//             and creates no additional job.
//   Req 5.2 — idempotency is enforced by the unique index + ON CONFLICT clause
//             (modeled here by the executor's conflict handling on media_id).
//   Req 5.3 — running the same enqueue more than once yields the same final set
//             of jobs as running it once.
import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { enqueuePosterJob } from '@/lib/poster-jobs';

// A minimal, faithful test double of the poster_jobs INSERT ... ON CONFLICT
// (media_id) DO NOTHING contract. It keeps one row per media_id (the unique
// index) and mirrors pg's rowCount semantics: 1 when a row is inserted, 0 on
// conflict. The helper only ever runs the enqueue INSERT, so a single SQL
// branch is enough; any other SQL is a test bug and throws loudly.
interface FakeJob {
    media_id: number;
    status: string;
    attempts: number;
}

function fakePosterJobsExecutor(): {
    pool: Pool;
    jobs: Map<number, FakeJob>;
    inserts: number;
    conflicts: number;
} {
    const jobs = new Map<number, FakeJob>();
    const state = { inserts: 0, conflicts: 0 };

    const query = async (sql: string, values?: unknown[]) => {
        if (!/INSERT INTO poster_jobs/i.test(sql)) {
            throw new Error(`Unexpected query in test: ${sql}`);
        }
        const mediaId = (values ?? [])[0] as number;
        // Unique index on media_id: first insert wins, later ones conflict.
        if (jobs.has(mediaId)) {
            state.conflicts += 1;
            return { rows: [], rowCount: 0 };
        }
        jobs.set(mediaId, { media_id: mediaId, status: 'pending', attempts: 0 });
        state.inserts += 1;
        return { rows: [], rowCount: 1 };
    };

    const pool = { query } as unknown as Pool;
    return {
        pool,
        jobs,
        get inserts() {
            return state.inserts;
        },
        get conflicts() {
            return state.conflicts;
        },
    };
}

describe('enqueuePosterJob — no-op on conflict', () => {
    it('returns true on first insert and false on a second enqueue for the same media_id', async () => {
        const db = fakePosterJobsExecutor();

        // First enqueue inserts a new job row (Req 5.1: a job now exists).
        const first = await enqueuePosterJob(db.pool, 42);
        expect(first).toBe(true);

        // Second enqueue for the SAME media_id is a silent no-op (Req 5.1, 5.2).
        const second = await enqueuePosterJob(db.pool, 42);
        expect(second).toBe(false);
    });

    it('creates exactly one job row for a media_id no matter how many times it is enqueued', async () => {
        const db = fakePosterJobsExecutor();

        // Enqueue the same media_id several times (Req 5.3: same final state as
        // enqueuing once).
        await enqueuePosterJob(db.pool, 7);
        await enqueuePosterJob(db.pool, 7);
        await enqueuePosterJob(db.pool, 7);

        // Exactly one job row exists for that media_id — no duplicates.
        expect(db.jobs.size).toBe(1);
        expect(db.jobs.get(7)).toEqual({ media_id: 7, status: 'pending', attempts: 0 });
        // One real insert; the remaining attempts were conflicts (no-ops).
        expect(db.inserts).toBe(1);
        expect(db.conflicts).toBe(2);
    });

    it('leaves the existing job unchanged when a conflicting enqueue occurs', async () => {
        const db = fakePosterJobsExecutor();

        await enqueuePosterJob(db.pool, 100);
        const before = { ...db.jobs.get(100)! };

        // A conflicting enqueue must not mutate the existing job (ON CONFLICT DO
        // NOTHING — Req 5.1).
        const result = await enqueuePosterJob(db.pool, 100);
        expect(result).toBe(false);
        expect(db.jobs.get(100)).toEqual(before);
    });

    it('inserts independent jobs for distinct media_ids', async () => {
        const db = fakePosterJobsExecutor();

        expect(await enqueuePosterJob(db.pool, 1)).toBe(true);
        expect(await enqueuePosterJob(db.pool, 2)).toBe(true);
        // Re-enqueuing either is a no-op; distinct ids never collide.
        expect(await enqueuePosterJob(db.pool, 1)).toBe(false);

        expect(db.jobs.size).toBe(2);
        expect(db.inserts).toBe(2);
        expect(db.conflicts).toBe(1);
    });

    it('treats a null rowCount from the driver as "no insert" (false)', async () => {
        // Some pg drivers report rowCount as null; the helper coalesces to 0,
        // which must be reported as false (no new row).
        const query = async () => ({ rows: [], rowCount: null });
        const pool = { query } as unknown as Pool;

        expect(await enqueuePosterJob(pool, 999)).toBe(false);
    });
});
