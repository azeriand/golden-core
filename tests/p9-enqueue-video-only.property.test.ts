// Property test P9 — "Enqueue is video-only" — Task 2.3.
//
// Property 2 (design.md / tasks.md):
//   For any media row, `enqueuePosterJob` is invoked by an enqueue path IF AND
//   ONLY IF the row's `type` denotes a video (`isVideoType` true); no poster
//   job is ever created for a non-video media row.
//   Validates: Requirements 3.1, 3.2, 4.1, 4.3, 13.2
//
// Modeling approach (mirrors the in-memory-reference style of P1):
//   - The queue-write contract of `poster_jobs` is modeled as an IN-MEMORY
//     fake executor that honors the unique index on media_id +
//     `ON CONFLICT (media_id) DO NOTHING`. It is a MODEL of the Postgres table,
//     not a real DB.
//   - The REAL `isVideoType` from `lib/poster-jobs.ts` is the single source of
//     truth both enqueue paths (Confirm_Route, Webhook_Path) and the backfill
//     use to gate enqueue. We model that gate directly: an enqueue path calls
//     `enqueuePosterJob(db, media_id)` ONLY WHEN `isVideoType(row.type)`.
//   - The REAL `enqueuePosterJob` runs against the fake executor.
//
// The property then asserts the biconditional: a job exists for a media_id
// AFTER the gated enqueue path runs IF AND ONLY IF that row's type is a video
// MIME. fast-check drives arbitrary `type` values across the whole input space
// (video/*, image/*, other MIME, junk, empty, null, undefined).

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { Pool } from 'pg';

import { enqueuePosterJob, isVideoType } from '@/lib/poster-jobs';

// --- In-memory poster_jobs fake executor -------------------------------------
// Models `INSERT INTO poster_jobs (...) VALUES (...) ON CONFLICT (media_id) DO
// NOTHING`. The Map keyed by media_id is the analog of the UNIQUE index on
// poster_jobs.media_id: a second insert for the same media_id inserts nothing
// (rowCount 0). This is the ONLY SQL the real `enqueuePosterJob` issues, so a
// faithful model of that one statement is sufficient.
interface PosterJobsModel {
    // Typed as pg's own Pool.query (its full overloaded signature) so the model
    // is assignable to the `Executor = Pick<Pool | PoolClient, 'query'>`
    // parameter of enqueuePosterJob under tsc. The single-string-SQL overload is
    // the only one the helper actually calls.
    query: Pool['query'];
    hasJob: (mediaId: number) => boolean;
    jobCount: () => number;
}

function createPosterJobsModel(): PosterJobsModel {
    const byMediaId = new Map<number, { media_id: number; status: string; attempts: number }>();

    async function query(sql: string, params?: unknown[]) {
        if (/INSERT INTO poster_jobs/i.test(sql)) {
            const mediaId = (params ?? [])[0] as number;
            // ON CONFLICT (media_id) DO NOTHING: only insert when absent.
            if (byMediaId.has(mediaId)) {
                return { rowCount: 0, rows: [] };
            }
            byMediaId.set(mediaId, { media_id: mediaId, status: 'pending', attempts: 0 });
            return { rowCount: 1, rows: [] };
        }
        throw new Error(`Unexpected query in P9 model: ${sql}`);
    }

    return {
        // One localized cast adapts the plain (sql, params) implementation to
        // pg's overloaded Pool['query'] type (mirrors how a real pg client
        // satisfies its many overloads with a single body).
        query: query as unknown as Pool['query'],
        hasJob: (mediaId: number) => byMediaId.has(mediaId),
        jobCount: () => byMediaId.size,
    };
}

// Model of an enqueue path (Confirm_Route / Webhook_Path / backfill share this
// gate): create a poster job ONLY for videos, using the real `isVideoType`
// predicate as the sole gate. Returns whether enqueue was attempted.
async function runEnqueuePath(
    db: PosterJobsModel,
    row: { media_id: number; type: string | null | undefined },
): Promise<boolean> {
    if (isVideoType(row.type)) {
        // The model exposes `.query` with the pg executor signature, so it
        // satisfies the `Executor` type the real helper accepts.
        await enqueuePosterJob(db, row.media_id);
        return true;
    }
    return false;
}

// --- fast-check generators ----------------------------------------------------

// Video MIME strings: anything beginning with 'video/'.
const videoTypeArb = fc
    .stringMatching(/^[a-z0-9.+-]{1,20}$/)
    .map((sub) => `video/${sub || 'mp4'}`);

// Non-video types spanning the rest of the input space: image MIMEs, other
// MIMEs, junk strings that merely CONTAIN "video" but do not START with it,
// empty string, null, and undefined.
const nonVideoTypeArb = fc.oneof(
    fc.constantFrom('image/jpeg', 'image/png', 'image/webp', 'image/gif'),
    fc.constantFrom('application/octet-stream', 'text/plain', 'audio/mpeg', 'application/mp4'),
    // Sneaky strings that reference "video" but are NOT a video MIME.
    fc.constantFrom('notvideo/mp4', ' video/mp4', 'x-video/mp4', 'my video/mp4', 'VIDEO/mp4'),
    fc.constant(''),
    fc.constant(null),
    fc.constant(undefined),
    // Arbitrary junk that does not start with 'video/'.
    fc.string().filter((s) => !s.startsWith('video/')),
);

const anyTypeArb: fc.Arbitrary<string | null | undefined> = fc.oneof(
    videoTypeArb,
    nonVideoTypeArb,
);

const mediaIdArb = fc.integer({ min: 1, max: 1_000_000 });

const NUM_RUNS = 200;

describe('P9 — enqueue is video-only', () => {
    it('creates a poster job IF AND ONLY IF the media type is a video MIME', async () => {
        await fc.assert(
            fc.asyncProperty(mediaIdArb, anyTypeArb, async (mediaId, type) => {
                const model = createPosterJobsModel();

                const attempted = await runEnqueuePath(model, { media_id: mediaId, type });

                const isVideo = isVideoType(type);

                // Gate agreement: the path attempts enqueue exactly when video.
                expect(attempted).toBe(isVideo);

                // BICONDITIONAL: a job exists for this media_id iff video.
                expect(model.hasJob(mediaId)).toBe(isVideo);

                // No job is EVER created for a non-video row.
                if (!isVideo) {
                    expect(model.jobCount()).toBe(0);
                } else {
                    expect(model.jobCount()).toBe(1);
                }
            }),
            { numRuns: NUM_RUNS },
        );
    });

    it('never enqueues for any non-video type across the input space', async () => {
        await fc.assert(
            fc.asyncProperty(mediaIdArb, nonVideoTypeArb, async (mediaId, type) => {
                // Guard the generator invariant: these are never videos.
                expect(isVideoType(type)).toBe(false);

                const model = createPosterJobsModel();
                const attempted = await runEnqueuePath(model, { media_id: mediaId, type });

                expect(attempted).toBe(false);
                expect(model.hasJob(mediaId)).toBe(false);
                expect(model.jobCount()).toBe(0);
            }),
            { numRuns: NUM_RUNS },
        );
    });

    it('always enqueues exactly one job for any video MIME type', async () => {
        await fc.assert(
            fc.asyncProperty(mediaIdArb, videoTypeArb, async (mediaId, type) => {
                expect(isVideoType(type)).toBe(true);

                const model = createPosterJobsModel();
                const attempted = await runEnqueuePath(model, { media_id: mediaId, type });

                expect(attempted).toBe(true);
                expect(model.hasJob(mediaId)).toBe(true);
                expect(model.jobCount()).toBe(1);
            }),
            { numRuns: NUM_RUNS },
        );
    });
});
