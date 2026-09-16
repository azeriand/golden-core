// Property test P16 — "Processing idempotency (re-run safety)" — Task 9.4.
//
// Property 9 (design.md "Correctness Properties"):
//   For a media row already having a non-null `poster_url`, processing transitions
//   to `done` without generating a new image and without changing `poster_url`.
//   Validates: Requirements 10.1, 10.3, 10.4
//
// Why this property holds in process-job.ts:
//   The per-job pipeline (worker/src/process-job.ts) loads the media row FIRST,
//   then checks `media.poster_url`. When it is already non-null (and non-empty),
//   the pipeline takes the idempotent short-circuit (Req 10.1):
//       await deps.completeJob(job.id, db);  // -> status 'done'
//       return;                              // BEFORE any extract/upload/UPDATE
//   Because it returns before extractFrame, uploadPoster, or the
//   `UPDATE media SET poster_url = $1` statement, a re-run after a crash/timeout
//   cannot regenerate a poster (Req 10.3) and cannot overwrite the existing
//   poster_url with a new or partial value (Req 10.4). The stored value the row
//   had before the re-run is exactly the value it has after.
//
// Modeling approach (mirrors the in-memory-reference style of P14/P15):
//   We drive the REAL `processJob` against an IN-MEMORY reference model of the
//   two tables it touches — `public.media` (content, type, poster_url) and
//   `public.poster_jobs` (status/attempts) — with the effectful boundaries
//   (ffmpeg frame extraction + Blob upload) wired to THROW if they are ever
//   called. On the idempotent path they must NOT run, so any invocation is a
//   loud failure that would surface as a violated assertion (status not 'done'
//   / poster changed). The model also RECORDS every write to media.poster_url so
//   the test can assert that zero writes occurred on the idempotent path.
//
// TYPING NOTE: the fake executor's `query` is typed as pg's own `Pool['query']`
//   (its full overloaded signature) so the model is assignable to the pipeline's
//   `Executor = Pick<Pool | PoolClient, 'query'>` dependency under `tsc`. The
//   implementation is a plain async (sql, params) function adapted to that
//   overloaded type via one localized `as unknown as` cast, exactly as P14/P15's
//   createModel does — this keeps the new file free of new tsc errors.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { Pool } from 'pg';

import {
    processJob,
    type ProcessJobDeps,
    type PosterUploadResult,
} from '../worker/src/process-job';
import type { PosterJob } from '../worker/src/queue';
import type { WorkerConfig } from '../worker/src/config';
import type { ExtractedFrame, ExtractFrameOptions } from '../worker/src/frame';

// --- In-memory media + poster_jobs reference model ---------------------------

type JobStatus = 'pending' | 'processing' | 'done' | 'failed';

interface MediaRow {
    media_id: number;
    content: string;
    type: string | null;
    poster_url: string | null;
}

interface JobRow {
    id: number;
    media_id: number;
    status: JobStatus;
    attempts: number;
}

interface Model {
    /** Executor injected as the pipeline's `db` (SELECT media / UPDATE media). */
    db: { query: Pool['query'] };
    /** completeJob wired to the model (poster_jobs: -> 'done'). */
    completeJob: (jobId: number) => Promise<void>;
    /** failJob wired to the model (poster_jobs: attempts+1; pending or failed). */
    failJob: (
        jobId: number,
        attempts: number,
        maxAttempts: number,
    ) => Promise<void>;
    mediaPosterUrl: (mediaId: number) => string | null | undefined;
    jobStatus: (jobId: number) => JobStatus | undefined;
    jobs: () => JobRow[];
    /** How many times UPDATE media SET poster_url ran (must be 0 on re-run). */
    posterWriteCount: (mediaId: number) => number;
}

function createModel(media: MediaRow[], jobs: JobRow[]): Model {
    const mediaById = new Map<number, MediaRow>();
    for (const m of media) mediaById.set(m.media_id, { ...m });
    const jobsById = new Map<number, JobRow>();
    for (const j of jobs) jobsById.set(j.id, { ...j });
    // media_id -> number of poster_url writes it received. Any write on the
    // idempotent re-run path is a violation of the property, so we count them.
    const posterWrites = new Map<number, number>();

    // Faithful model of the ONLY two media statements processJob issues.
    const queryImpl = async (
        sql: string,
        params?: unknown[],
    ): Promise<{ rows: unknown[]; rowCount: number }> => {
        // SELECT content, type, poster_url FROM media WHERE media_id = $1
        if (/SELECT\s+content,\s*type,\s*poster_url\s+FROM\s+media/i.test(sql)) {
            const mediaId = (params ?? [])[0] as number;
            const row = mediaById.get(mediaId);
            return {
                rows: row
                    ? [{ content: row.content, type: row.type, poster_url: row.poster_url }]
                    : [],
                rowCount: row ? 1 : 0,
            };
        }
        // UPDATE media SET poster_url = $1 WHERE media_id = $2
        // The ONLY poster_url mutation. On the idempotent re-run path the pipeline
        // must never reach here; we record every write so the test can assert 0.
        if (/UPDATE\s+media\s+SET\s+poster_url\s*=\s*\$1/i.test(sql)) {
            const url = (params ?? [])[0] as string;
            const mediaId = (params ?? [])[1] as number;
            const row = mediaById.get(mediaId);
            if (row) row.poster_url = url;
            posterWrites.set(mediaId, (posterWrites.get(mediaId) ?? 0) + 1);
            return { rows: [], rowCount: row ? 1 : 0 };
        }
        throw new Error(`Unexpected query in P16 model: ${sql}`);
    };

    return {
        db: { query: queryImpl as unknown as Pool['query'] },
        completeJob: async (jobId) => {
            const j = jobsById.get(jobId);
            if (j) j.status = 'done';
        },
        failJob: async (jobId, attempts, maxAttempts) => {
            const j = jobsById.get(jobId);
            if (!j) return;
            j.attempts = attempts + 1;
            j.status = attempts + 1 >= maxAttempts ? 'failed' : 'pending';
        },
        mediaPosterUrl: (mediaId) => mediaById.get(mediaId)?.poster_url,
        jobStatus: (jobId) => jobsById.get(jobId)?.status,
        jobs: () => [...jobsById.values()].map((j) => ({ ...j })),
        posterWriteCount: (mediaId) => posterWrites.get(mediaId) ?? 0,
    };
}

// --- Config used by every scenario -------------------------------------------

const BASE_CONFIG: WorkerConfig = {
    databaseUrl: 'postgres://not-a-real-secret/localhost',
    blobReadWriteToken: 'not-a-real-token',
    concurrency: 2,
    maxAttempts: 5,
    pollIntervalMs: 0,
    staleProcessingSeconds: 300,
    maxDimension: 640,
    backoffBaseSeconds: 5,
};

// Deps whose effectful boundaries THROW if invoked. On the idempotent re-run
// path (media already has a non-null poster_url) neither extraction nor upload
// may run, so wiring them to throw turns any accidental regeneration into a
// visible failure (the job would route to failJob and never reach 'done').
function throwingDeps(model: Model): ProcessJobDeps {
    return {
        config: BASE_CONFIG,
        db: model.db,
        extractFrame: async (_options: ExtractFrameOptions): Promise<ExtractedFrame> => {
            throw new Error('extractFrame must NOT run on the idempotent re-run path');
        },
        uploadPoster: async (
            _pathname: string,
            _frame: ExtractedFrame,
            _config: WorkerConfig,
        ): Promise<PosterUploadResult> => {
            throw new Error('uploadPoster must NOT run on the idempotent re-run path');
        },
        completeJob: (jobId) => model.completeJob(jobId),
        failJob: (jobId, attempts, maxAttempts) =>
            model.failJob(jobId, attempts, maxAttempts),
    };
}

// --- fast-check generators ----------------------------------------------------

// A single already-postered video media row + its poster_job. `poster` is the
// NON-NULL, non-empty pre-existing poster_url that drives the idempotent path.
// `attempts` is the pre-run attempt count (irrelevant on the re-run path since
// the job completes, but kept to exercise arbitrary job states).
const jobShapeArb = fc.record({
    content: fc.webUrl(),
    // Mostly videos; a few non-video/null types kept for realism. The re-run
    // short-circuit fires purely on poster_url being non-null, regardless of type.
    type: fc.constantFrom<string | null>(
        'video/mp4',
        'video/quicktime',
        'video/webm',
        'image/jpeg',
        null,
    ),
    // A non-empty existing poster: this is what makes the row take the idempotent
    // path. fc.webUrl() is always a non-empty string.
    poster: fc.webUrl(),
    attempts: fc.integer({ min: 0, max: 6 }),
});

// A set of distinct-media jobs, each already having a poster. Media ids / job ids
// are remapped by index so each job maps to its own media row (one poster_job per
// media_id — Req 2.4).
const scenarioArb = fc
    .array(jobShapeArb, { minLength: 0, maxLength: 30 })
    .map((shapes) =>
        shapes.map((s, i) => ({
            ...s,
            media_id: i + 1,
            id: i + 1,
        })),
    );

const NUM_RUNS = 200;

describe('P16 — processing idempotency (re-run safety)', () => {
    it('a re-run over an already-postered row ends done, keeps poster_url, and generates no new image', async () => {
        await fc.assert(
            fc.asyncProperty(scenarioArb, async (entries) => {
                const media: MediaRow[] = entries.map((e) => ({
                    media_id: e.media_id,
                    content: e.content,
                    type: e.type,
                    poster_url: e.poster,
                }));
                const jobs: JobRow[] = entries.map((e) => ({
                    id: e.id,
                    media_id: e.media_id,
                    status: 'processing' as JobStatus,
                    attempts: e.attempts,
                }));

                const model = createModel(media, jobs);

                // Snapshot the pre-run poster_url for every row so we can assert
                // byte-for-byte preservation afterward (Req 10.4).
                const before = new Map<number, string | null | undefined>();
                for (const e of entries) {
                    before.set(e.media_id, model.mediaPosterUrl(e.media_id));
                }

                // Drive the REAL pipeline for every already-postered job. The
                // extract/upload boundaries throw if called; on the idempotent
                // path they must not run (processJob would otherwise route the
                // throw to failJob, leaving the job NOT 'done').
                const deps = throwingDeps(model);
                for (const e of entries) {
                    const job: PosterJob = {
                        id: e.id,
                        media_id: e.media_id,
                        status: 'processing',
                        attempts: e.attempts,
                        run_after: new Date().toISOString(),
                    };
                    await processJob(job, deps);
                }

                for (const e of entries) {
                    // (a) DONE: the idempotent short-circuit marks the job done
                    //     without regeneration (Req 10.1). If extract/upload had
                    //     run, they would have thrown and the job would be
                    //     pending/failed instead.
                    expect(model.jobStatus(e.id)).toBe('done');

                    // (b) NO NEW IMAGE: the poster_url UPDATE never ran, i.e. no
                    //     regeneration/rewrite occurred (Req 10.3).
                    expect(model.posterWriteCount(e.media_id)).toBe(0);

                    // (c) POSTER UNCHANGED: the stored value equals its pre-run
                    //     value, byte-for-byte, never a partial value (Req 10.4).
                    expect(model.mediaPosterUrl(e.media_id)).toBe(
                        before.get(e.media_id),
                    );
                }
            }),
            { numRuns: NUM_RUNS },
        );
    });

    it('re-running the SAME already-postered job multiple times stays done with the exact same poster', async () => {
        // Focused case: repeated re-runs (crash/timeout reclaim happening several
        // times) must be indistinguishable from a single run — status stays done,
        // poster_url is never regenerated or altered.
        await fc.assert(
            fc.asyncProperty(
                fc.record({
                    media_id: fc.integer({ min: 1, max: 1_000_000 }),
                    content: fc.webUrl(),
                    existingPoster: fc.webUrl(),
                    rounds: fc.integer({ min: 1, max: 6 }),
                }),
                async ({ media_id, content, existingPoster, rounds }) => {
                    const model = createModel(
                        [
                            {
                                media_id,
                                content,
                                type: 'video/mp4',
                                poster_url: existingPoster,
                            },
                        ],
                        [{ id: 1, media_id, status: 'processing', attempts: 0 }],
                    );

                    const deps = throwingDeps(model);

                    for (let r = 0; r < rounds; r++) {
                        await processJob(
                            {
                                id: 1,
                                media_id,
                                status: 'processing',
                                attempts: 0,
                                run_after: new Date().toISOString(),
                            },
                            deps,
                        );

                        // Every round: done, poster preserved exactly, no writes.
                        expect(model.jobStatus(1)).toBe('done');
                        expect(model.mediaPosterUrl(media_id)).toBe(existingPoster);
                        expect(model.posterWriteCount(media_id)).toBe(0);
                    }
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });
});
