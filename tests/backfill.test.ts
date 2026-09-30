// Unit test for backfill idempotency — Task 11.2 (generalised from poster-only).
// worker/src/backfill.ts `runBackfill`
//
// Focus: CONCRETE, example-based verification of the one-time backfill contract.
// media-transcoding generalises the backfill from a single poster INSERT into
// THREE set-based statements against the unified media_jobs queue, one per kind:
//   - poster: videos (type LIKE 'video/%') with poster_url IS NULL
//   - video:  all videos (type LIKE 'video/%')            [transcode derivative]
//   - image:  all images (type LIKE 'image/%')            [display derivative]
// each guarded by ON CONFLICT (media_id, kind) DO NOTHING (the media_jobs unique
// index analog). We drive the REAL `runBackfill` against a small in-memory model
// that interprets exactly those statements over a fixture `media` table plus a
// media_jobs map keyed by (media_id, kind). No production code is refactored for
// testability — the helper already accepts an injectable executor.
//
// Covered behavior:
//   - enqueue poster+video for eligible videos; image for images; nothing for
//     null/other types.
//   - poster kind respects poster_url IS NULL; video/image kinds rely on
//     ON CONFLICT for idempotency.
//   - rerunning creates no duplicate jobs (idempotent).
//   - media rows and their content are never modified.
import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { runBackfill } from '@/worker/src/backfill';

interface MediaRow {
    media_id: number;
    type: string | null;
    poster_url: string | null;
    content: string;
}

interface MediaJobRow {
    media_id: number;
    kind: string;
    status: string;
    attempts: number;
}

// Build a faithful in-memory executor over a fixed set of media rows. It
// interprets the three backfill INSERT ... SELECT ... ON CONFLICT statements by
// keying jobs on `${media_id}:${kind}` (the (media_id, kind) unique index).
function fakeBackfillExecutor(media: MediaRow[]): {
    pool: Pool;
    jobs: Map<string, MediaJobRow>;
    media: MediaRow[];
    runs: number;
} {
    const mediaTable: MediaRow[] = media.map((m) => ({ ...m }));
    const jobs = new Map<string, MediaJobRow>();
    const state = { runs: 0 };

    const key = (mediaId: number, kind: string) => `${mediaId}:${kind}`;

    const query = async (sql: string) => {
        if (!/INSERT INTO media_jobs/i.test(sql) || !/FROM media/i.test(sql)) {
            throw new Error(`Unexpected query in backfill test: ${sql}`);
        }
        state.runs += 1;

        // Determine the kind + eligibility from the statement's SELECT literal
        // and WHERE clause (faithful to the real backfill SQL).
        let kind: 'poster' | 'video' | 'image';
        let candidates: MediaRow[];
        if (/'poster'/.test(sql)) {
            kind = 'poster';
            candidates = mediaTable.filter(
                (m) =>
                    typeof m.type === 'string' &&
                    m.type.startsWith('video/') &&
                    m.poster_url === null,
            );
        } else if (/'video'/.test(sql)) {
            kind = 'video';
            candidates = mediaTable.filter(
                (m) => typeof m.type === 'string' && m.type.startsWith('video/'),
            );
        } else if (/'image'/.test(sql)) {
            kind = 'image';
            candidates = mediaTable.filter(
                (m) => typeof m.type === 'string' && m.type.startsWith('image/'),
            );
        } else {
            throw new Error(`Unrecognized backfill kind in SQL: ${sql}`);
        }

        // INSERT ... ON CONFLICT (media_id, kind) DO NOTHING.
        let inserted = 0;
        for (const m of candidates) {
            const k = key(m.media_id, kind);
            if (jobs.has(k)) continue; // conflict -> DO NOTHING
            jobs.set(k, { media_id: m.media_id, kind, status: 'pending', attempts: 0 });
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

// Fixture: two videos without a poster, one video WITH a poster, one image, and
// one null-type row.
function baseFixture(): MediaRow[] {
    return [
        { media_id: 1, type: 'video/mp4', poster_url: null, content: 'blob://v1' },
        { media_id: 2, type: 'video/quicktime', poster_url: null, content: 'blob://v2' },
        { media_id: 3, type: 'video/mp4', poster_url: 'blob://poster3', content: 'blob://v3' },
        { media_id: 4, type: 'image/jpeg', poster_url: null, content: 'blob://i4' },
        { media_id: 5, type: null, poster_url: null, content: 'blob://x5' },
    ];
}

describe('runBackfill — enqueues per-kind derivative jobs for eligible media', () => {
    it('enqueues poster+video for videos, image for images, and nothing for null/other types', async () => {
        const db = fakeBackfillExecutor(baseFixture());

        const enqueued = await runBackfill(db.pool);

        // poster: videos 1,2 (poster_url NULL) = 2
        // video:  videos 1,2,3 = 3
        // image:  image 4 = 1
        // total newly-enqueued = 6
        expect(enqueued).toBe(6);
        expect(db.jobs.size).toBe(6);

        // Poster jobs: only 1 and 2 (video 3 already has a poster).
        expect(db.jobs.has('1:poster')).toBe(true);
        expect(db.jobs.has('2:poster')).toBe(true);
        expect(db.jobs.has('3:poster')).toBe(false);

        // Video (transcode) jobs: all three videos, including the poster'd one.
        expect(db.jobs.has('1:video')).toBe(true);
        expect(db.jobs.has('2:video')).toBe(true);
        expect(db.jobs.has('3:video')).toBe(true);

        // Image job: only the image row.
        expect(db.jobs.has('4:image')).toBe(true);

        // The null-type row is never enqueued for any kind.
        expect(db.jobs.has('5:poster')).toBe(false);
        expect(db.jobs.has('5:video')).toBe(false);
        expect(db.jobs.has('5:image')).toBe(false);
    });

    it('skips a (media_id, kind) that already has an existing job', async () => {
        const db = fakeBackfillExecutor(baseFixture());
        // Pre-seed a poster job for media_id 1 as if a prior enqueue path ran.
        db.jobs.set('1:poster', { media_id: 1, kind: 'poster', status: 'processing', attempts: 2 });

        const enqueued = await runBackfill(db.pool);

        // One fewer poster insert than a clean run (1:poster conflicts): 6 - 1 = 5.
        expect(enqueued).toBe(5);
        // The pre-existing job is left exactly as it was.
        expect(db.jobs.get('1:poster')).toEqual({
            media_id: 1,
            kind: 'poster',
            status: 'processing',
            attempts: 2,
        });
    });
});

describe('runBackfill — idempotent on rerun', () => {
    it('a second run creates no duplicate jobs and enqueues nothing new', async () => {
        const db = fakeBackfillExecutor(baseFixture());

        const first = await runBackfill(db.pool);
        expect(first).toBe(6);
        expect(db.jobs.size).toBe(6);

        const second = await runBackfill(db.pool);
        expect(second).toBe(0);
        expect(db.jobs.size).toBe(6);

        const third = await runBackfill(db.pool);
        expect(third).toBe(0);
        expect(db.jobs.size).toBe(6);
    });
});

describe('runBackfill — leaves media unchanged', () => {
    it('does not modify any media row or its content value', async () => {
        const before = baseFixture();
        const db = fakeBackfillExecutor(before);

        await runBackfill(db.pool);
        await runBackfill(db.pool);

        expect(db.media).toEqual(before);
    });
});

describe('runBackfill — driver rowCount edge case', () => {
    it('treats a null rowCount from the driver as zero newly enqueued', async () => {
        // Every statement returns null rowCount; runBackfill coalesces each to 0.
        const query = async () => ({ rows: [], rowCount: null });
        const pool = { query } as unknown as Pool;

        expect(await runBackfill(pool)).toBe(0);
    });
});
