// Property test P14 — "A done job implies a non-null poster_url" — Task 9.2.
//
// Property 3 (design.md "Correctness Properties"):
//   For any sequence of worker operations over any set of jobs, whenever a job's
//   status is `done`, the corresponding media row's `poster_url` is non-null.
//   Validates: Requirements 8.4, 8.5, 10.1, 10.4
//
// Why this property holds in process-job.ts:
//   The per-job pipeline (worker/src/process-job.ts) only ever reaches a `done`
//   transition (deps.completeJob) on TWO paths, and both guarantee a non-null
//   poster_url on the backing media row:
//     (a) Idempotent re-run (Req 10.1): the media row ALREADY has a non-null
//         poster_url, so the job is marked done WITHOUT regenerating and WITHOUT
//         touching poster_url. Non-null in => non-null out.
//     (b) Fresh generation (Req 8.4, 8.5, 10.4): the pipeline extracts a frame,
//         uploads the poster, writes the SINGLE final URL to media.poster_url via
//         `UPDATE media SET poster_url = $1`, and ONLY THEN calls completeJob.
//         So by the time the job is `done`, poster_url is the uploaded URL.
//   The failure path (deps.failJob) never marks a job `done` and never writes
//   poster_url, so a failed/pending job is irrelevant to this property.
//
// Modeling approach (mirrors the in-memory-reference style of P8-P13):
//   We drive the REAL `processJob` against an IN-MEMORY reference model of the
//   two tables it touches — `public.media` (content, type, poster_url) and
//   `public.poster_jobs` (status/attempts) — plus mocked-but-success-shaped
//   effectful boundaries:
//     - extractFrame: returns a small in-memory ExtractedFrame (ffmpeg mocked).
//     - uploadPoster: returns a deterministic Blob URL (network/Blob mocked).
//     - completeJob / failJob: wired to the model so they mutate poster_jobs
//       exactly as the real queue SQL would (done / attempts+backoff-or-failed).
//   The model's `.query` interprets the ONLY two statements processJob issues
//   against `db`:
//       SELECT content, type, poster_url FROM media WHERE media_id = $1
//       UPDATE media SET poster_url = $1 WHERE media_id = $2
//   so exercising the real pipeline over randomized job sets verifies the
//   invariant without ffmpeg, the network, or Postgres.
//
// TYPING NOTE: the fake executor's `query` is typed as pg's own `Pool['query']`
//   (its full overloaded signature) so the model is assignable to the pipeline's
//   `Executor = Pick<Pool | PoolClient, 'query'>` dependency under `tsc`. The
//   implementation is a plain async (sql, params) function adapted to that
//   overloaded type via one localized cast, exactly as p13 does — this keeps the
//   new file free of new tsc errors.

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
}

function createModel(media: MediaRow[], jobs: JobRow[]): Model {
    const mediaById = new Map<number, MediaRow>();
    for (const m of media) mediaById.set(m.media_id, { ...m });
    const jobsById = new Map<number, JobRow>();
    for (const j of jobs) jobsById.set(j.id, { ...j });

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
        if (/UPDATE\s+media\s+SET\s+poster_url\s*=\s*\$1/i.test(sql)) {
            const url = (params ?? [])[0] as string;
            const mediaId = (params ?? [])[1] as number;
            const row = mediaById.get(mediaId);
            if (row) row.poster_url = url;
            return { rows: [], rowCount: row ? 1 : 0 };
        }
        throw new Error(`Unexpected query in P14 model: ${sql}`);
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
    };
}

// --- Mocked effectful boundaries (success-shaped) ----------------------------

// A tiny, valid-shaped ExtractedFrame. ffmpeg + sharp are entirely mocked; the
// bytes are irrelevant to this property (we only care about the done => poster
// invariant), so a fixed small buffer suffices.
const FAKE_FRAME: ExtractedFrame = {
    data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    width: 320,
    height: 240,
    contentType: 'image/jpeg',
    extension: 'jpg',
};

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

// --- fast-check generators ----------------------------------------------------

// A single video media row + its poster_job. `initialPoster` decides whether the
// row ALREADY has a poster (drives the idempotent re-run path, Req 10.1) or not
// (drives fresh generation). `extractFails`/`uploadFails` inject processing
// failures so the property is also exercised on the failure path (where the job
// must NOT become done). `attempts` is the pre-failure attempt count.
const jobShapeArb = fc.record({
    media_id: fc.integer({ min: 1, max: 1_000_000 }),
    content: fc.webUrl(),
    // Mostly videos; a few non-video/null types to keep the model realistic.
    type: fc.constantFrom<string | null>(
        'video/mp4',
        'video/quicktime',
        'video/webm',
        'image/jpeg',
        null,
    ),
    // Whether the media row already has a poster before processing.
    initialPoster: fc.option(fc.webUrl(), { nil: null }),
    attempts: fc.integer({ min: 0, max: 6 }),
    extractFails: fc.boolean(),
    uploadFails: fc.boolean(),
});

// A set of distinct-media jobs. Media ids are made unique by index remap so each
// job maps to its own media row (one poster_job per media_id — Req 2.4).
const scenarioArb = fc
    .array(jobShapeArb, { minLength: 0, maxLength: 30 })
    .map((shapes) =>
        shapes.map((s, i) => ({
            ...s,
            // Guarantee unique media_id (and job id) per entry.
            media_id: i + 1,
            id: i + 1,
        })),
    );

const NUM_RUNS = 200;

describe('P14 — a done job implies a non-null poster_url', () => {
    it('every job that ends done has a non-null poster_url on its media row', async () => {
        await fc.assert(
            fc.asyncProperty(scenarioArb, async (entries) => {
                const media: MediaRow[] = entries.map((e) => ({
                    media_id: e.media_id,
                    content: e.content,
                    type: e.type,
                    poster_url: e.initialPoster,
                }));
                const jobs: JobRow[] = entries.map((e) => ({
                    id: e.id,
                    media_id: e.media_id,
                    status: 'processing' as JobStatus,
                    attempts: e.attempts,
                }));

                const model = createModel(media, jobs);

                // Process every job through the REAL pipeline, injecting mocked
                // (success- or failure-shaped) boundaries per entry.
                for (const e of entries) {
                    const extractFrame = async (
                        _options: ExtractFrameOptions,
                    ): Promise<ExtractedFrame> => {
                        if (e.extractFails) {
                            throw new Error('mock: cannot decode frame');
                        }
                        return FAKE_FRAME;
                    };
                    const uploadPoster = async (
                        pathname: string,
                        _frame: ExtractedFrame,
                        _config: WorkerConfig,
                    ): Promise<PosterUploadResult> => {
                        if (e.uploadFails) {
                            throw new Error('mock: blob upload failed');
                        }
                        return { url: `https://blob.example/${pathname}` };
                    };

                    const deps: ProcessJobDeps = {
                        config: BASE_CONFIG,
                        db: model.db,
                        extractFrame,
                        uploadPoster,
                        completeJob: (jobId) => model.completeJob(jobId),
                        failJob: (jobId, attempts, maxAttempts) =>
                            model.failJob(jobId, attempts, maxAttempts),
                    };

                    const job: PosterJob = {
                        id: e.id,
                        media_id: e.media_id,
                        status: 'processing',
                        attempts: e.attempts,
                        run_after: new Date().toISOString(),
                    };

                    // processJob never throws for a normal failure (Req 17.4).
                    await processJob(job, deps);
                }

                // THE PROPERTY: any job now `done` implies a non-null poster_url
                // on its media row (Req 8.4, 8.5, 10.1, 10.4).
                for (const j of model.jobs()) {
                    if (j.status === 'done') {
                        const poster = model.mediaPosterUrl(j.media_id);
                        expect(poster).not.toBeNull();
                        expect(poster).not.toBeUndefined();
                        expect(typeof poster).toBe('string');
                        expect((poster as string).length).toBeGreaterThan(0);
                    }
                }
            }),
            { numRuns: NUM_RUNS },
        );
    });

    it('a fresh video job whose extraction+upload succeed becomes done with the uploaded poster', async () => {
        // Focused positive case: no initial poster, no injected failure => the
        // pipeline must write the uploaded URL and mark the job done (Req 8.4/8.5).
        await fc.assert(
            fc.asyncProperty(
                fc.record({
                    media_id: fc.integer({ min: 1, max: 1_000_000 }),
                    content: fc.webUrl(),
                }),
                async ({ media_id, content }) => {
                    const model = createModel(
                        [{ media_id, content, type: 'video/mp4', poster_url: null }],
                        [{ id: 1, media_id, status: 'processing', attempts: 0 }],
                    );

                    const deps: ProcessJobDeps = {
                        config: BASE_CONFIG,
                        db: model.db,
                        extractFrame: async () => FAKE_FRAME,
                        uploadPoster: async (pathname) => ({
                            url: `https://blob.example/${pathname}`,
                        }),
                        completeJob: (jobId) => model.completeJob(jobId),
                        failJob: (jobId, attempts, maxAttempts) =>
                            model.failJob(jobId, attempts, maxAttempts),
                    };

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

                    expect(model.jobStatus(1)).toBe('done');
                    expect(model.mediaPosterUrl(media_id)).toBe(
                        `https://blob.example/posters/${media_id}/poster.jpg`,
                    );
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });

    it('a re-run over an already-postered row stays done and preserves the existing poster (Req 10.1)', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.record({
                    media_id: fc.integer({ min: 1, max: 1_000_000 }),
                    content: fc.webUrl(),
                    existingPoster: fc.webUrl(),
                }),
                async ({ media_id, content, existingPoster }) => {
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

                    // Extraction/upload MUST NOT run on the idempotent path; make
                    // them throw so any regeneration would be caught as a failure.
                    const deps: ProcessJobDeps = {
                        config: BASE_CONFIG,
                        db: model.db,
                        extractFrame: async () => {
                            throw new Error('extraction must not run on re-run');
                        },
                        uploadPoster: async () => {
                            throw new Error('upload must not run on re-run');
                        },
                        completeJob: (jobId) => model.completeJob(jobId),
                        failJob: (jobId, attempts, maxAttempts) =>
                            model.failJob(jobId, attempts, maxAttempts),
                    };

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

                    // done, and poster_url is exactly the pre-existing value.
                    expect(model.jobStatus(1)).toBe('done');
                    expect(model.mediaPosterUrl(media_id)).toBe(existingPoster);
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });
});
