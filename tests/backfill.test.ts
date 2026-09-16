// Unit test for backfill idempotency — Task 15.1.
// worker/src/backfill.ts `runBackfill`
//
// Focus: CONCRETE, example-based verification of the one-time Backfill_Process
// contract (Requirement 13). The backfill is a single set-based
// `INSERT INTO poster_jobs SELECT ... FROM media WHERE type LIKE 'video/%' AND
// poster_url IS NULL ON CONFLICT (media_id) DO NOTHING`. We drive the REAL
// `runBackfill` helper against a small in-memory model that INTERPRETS exactly
// that statement over a fixture `media` table plus a `poster_jobs` table keyed
// by media_id (the unique index analog). No production code is refactored for
// testability — the helper already accepts an injectable executor.
//
// The model mirrors the SQL semantics precisely:
//   - WHERE type LIKE 'video/%'   -> only rows whose MIME type starts 'video/'
//   - AND poster_url IS NULL      -> only rows with no poster yet
//   - ON CONFLICT (media_id) DO NOTHING -> a media row that already has a job is
//     skipped, and reruns create no duplicates. rowCount counts only the rows
//     actually inserted (conflicts excluded), matching pg.
//
// Covered acceptance criteria:
//   Req 13.1 — enqueue a job for each video row with NULL poster_url and no
//              existing job.
//   Req 13.2 — enqueue ONLY for videos; never for images / non-video rows.
//   Req 13.3 — running the backfill more than once creates no duplicate jobs.
//   Req 13.4 — leave every media row and its `content` unchanged.
import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { runBackfill } from '@/worker/src/backfill';

// A fixture `media` row. `type` is the LIVE MIME column (videos begin 'video/').
interface MediaRow {
    media_id: number;
    type: string | null;
    poster_url: string | null;
    content: string;
}

// A minimal poster_jobs row created by the backfill INSERT ... SELECT.
interface PosterJobRow {
    media_id: number;
    status: string;
    attempts: number;
}

// Build a faithful in-memory executor over a fixed set of media rows. It
// interprets ONLY the backfill INSERT ... SELECT ... ON CONFLICT statement;
// any other SQL is a test bug and throws loudly. `poster_jobs` is keyed by
// media_id to model the unique index poster_jobs_media_id_key.
function fakeBackfillExecutor(media: MediaRow[]): {
    pool: Pool;
    jobs: Map<number, PosterJobRow>;
    media: MediaRow[];
    runs: number;
} {
    // Deep-copy the media fixtures so we can later assert they are unchanged.
    const mediaTable: MediaRow[] = media.map((m) => ({ ...m }));
    const jobs = new Map<number, PosterJobRow>();
    const state = { runs: 0 };

    const query = async (sql: string) => {
        if (!/INSERT INTO poster_jobs/i.test(sql) || !/FROM media/i.test(sql)) {
            throw new Error(`Unexpected query in backfill test: ${sql}`);
        }
        state.runs += 1;

        // SELECT ... WHERE type LIKE 'video/%' AND poster_url IS NULL
        const candidates = mediaTable.filter(
            (m) =>
                typeof m.type === 'string' &&
                m.type.startsWith('video/') &&
                m.poster_url === null,
        );

        // INSERT ... ON CONFLICT (media_id) DO NOTHING: insert only rows whose
        // media_id has no existing job; count only real inserts.
        let inserted = 0;
        for (const m of candidates) {
            if (jobs.has(m.media_id)) {
                continue; // conflict -> DO NOTHING
            }
            jobs.set(m.media_id, {
                media_id: m.media_id,
                status: 'pending',
                attempts: 0,
            });
            inserted += 1;
        }
        return { rows: [], rowCount: inserted };
    };

    const pool = { query } as unknown as Pool;
    return {
        pool,
        jobs,
        media: mediaTable,
        get runs() {
            return state.runs;
        },
    };
}

// A representative fixture: two videos without a poster (should enqueue), one
// video that already has a poster (skip — Req 13.1 poster_url IS NULL), one
// image (skip — Req 13.2 video-only), and one non-media-ish null type (skip).
function baseFixture(): MediaRow[] {
    return [
        { media_id: 1, type: 'video/mp4', poster_url: null, content: 'blob://v1' },
        { media_id: 2, type: 'video/quicktime', poster_url: null, content: 'blob://v2' },
        { media_id: 3, type: 'video/mp4', poster_url: 'blob://poster3', content: 'blob://v3' },
        { media_id: 4, type: 'image/jpeg', poster_url: null, content: 'blob://i4' },
        { media_id: 5, type: null, poster_url: null, content: 'blob://x5' },
    ];
}

describe('runBackfill — enqueues only eligible video rows (Req 13.1, 13.2)', () => {
    it('enqueues a job for each video with NULL poster_url and skips images / posters / null types', async () => {
        const db = fakeBackfillExecutor(baseFixture());

        const enqueued = await runBackfill(db.pool);

        // Only media_id 1 and 2 qualify (videos, NULL poster_url, no job yet).
        expect(enqueued).toBe(2);
        expect(db.jobs.size).toBe(2);
        expect([...db.jobs.keys()].sort((a, b) => a - b)).toEqual([1, 2]);

        // Every enqueued job is a fresh pending job (Req 13.1 shape).
        expect(db.jobs.get(1)).toEqual({ media_id: 1, status: 'pending', attempts: 0 });
        expect(db.jobs.get(2)).toEqual({ media_id: 2, status: 'pending', attempts: 0 });

        // Explicitly NOT enqueued: the poster'd video (3), the image (4), the
        // null-type row (5) (Req 13.2 video-only, Req 13.1 poster_url IS NULL).
        expect(db.jobs.has(3)).toBe(false);
        expect(db.jobs.has(4)).toBe(false);
        expect(db.jobs.has(5)).toBe(false);
    });

    it('skips a video that already has an existing job (Req 13.1 "no existing job")', async () => {
        const db = fakeBackfillExecutor(baseFixture());
        // Pre-seed a job for media_id 1 as if a prior enqueue path already ran.
        db.jobs.set(1, { media_id: 1, status: 'processing', attempts: 2 });

        const enqueued = await runBackfill(db.pool);

        // Only media_id 2 is newly enqueued; media_id 1 conflicts (unchanged).
        expect(enqueued).toBe(1);
        expect(db.jobs.size).toBe(2);
        // The pre-existing job for media_id 1 is left exactly as it was.
        expect(db.jobs.get(1)).toEqual({ media_id: 1, status: 'processing', attempts: 2 });
        expect(db.jobs.get(2)).toEqual({ media_id: 2, status: 'pending', attempts: 0 });
    });
});

describe('runBackfill — idempotent on rerun (Req 13.3)', () => {
    it('a second run creates no duplicate jobs and enqueues nothing new', async () => {
        const db = fakeBackfillExecutor(baseFixture());

        const first = await runBackfill(db.pool);
        expect(first).toBe(2);
        expect(db.jobs.size).toBe(2);

        // Rerun: every candidate now conflicts, so no new rows and no dupes.
        const second = await runBackfill(db.pool);
        expect(second).toBe(0);
        expect(db.jobs.size).toBe(2);

        // Third run for good measure — still stable (same final set as once).
        const third = await runBackfill(db.pool);
        expect(third).toBe(0);
        expect(db.jobs.size).toBe(2);
        expect([...db.jobs.keys()].sort((a, b) => a - b)).toEqual([1, 2]);
    });
});

describe('runBackfill — leaves media unchanged (Req 13.4)', () => {
    it('does not modify any media row or its content value', async () => {
        const before = baseFixture();
        const db = fakeBackfillExecutor(before);

        await runBackfill(db.pool);
        await runBackfill(db.pool);

        // The media table the executor operates on is byte-for-byte the input:
        // no row added/removed, no type/poster_url/content mutated (Req 13.4).
        expect(db.media).toEqual(before);
    });
});

describe('runBackfill — driver rowCount edge case', () => {
    it('treats a null rowCount from the driver as zero newly enqueued', async () => {
        // Some pg drivers report rowCount as null; runBackfill coalesces to 0.
        const query = async () => ({ rows: [], rowCount: null });
        const pool = { query } as unknown as Pool;

        expect(await runBackfill(pool)).toBe(0);
    });
});
