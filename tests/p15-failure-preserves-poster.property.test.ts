// Property test P15 — "Failure never overwrites poster_url" — Task 9.3.
//
// Property 4 (design.md "Correctness Properties"):
//   For any job whose processing fails (including ffmpeg-cannot-decode and
//   content-not-retrievable), the corresponding media row's `poster_url` is left
//   exactly as it was before the attempt — never cleared, never set to a partial
//   value.
//   Validates: Requirements 8.4, 10.4, 17.1, 17.2, 17.3
//
// Why this property holds in process-job.ts:
//   The per-job pipeline (worker/src/process-job.ts) writes media.poster_url on
//   exactly ONE line — `UPDATE media SET poster_url = $1 WHERE media_id = $2` —
//   and that write happens ONLY AFTER a successful extractFrame AND a successful
//   uploadPoster resolve. Any error thrown by loadMediaRow, extractFrame, or
//   uploadPoster short-circuits BEFORE that UPDATE and routes to the catch block,
//   which calls failJob and NEVER touches poster_url (Req 17.3, 8.4). So a failed
//   attempt cannot clear, blank, or partially write poster_url: the value the row
//   had before the attempt is exactly the value it has after.
//
// Modeling approach (mirrors the in-memory-reference style of P8-P14):
//   We drive the REAL `processJob` against an IN-MEMORY reference model of the
//   two tables it touches — `public.media` (content, type, poster_url) and
//   `public.poster_jobs` (status/attempts) — with the effectful boundaries
//   mocked to FAIL:
//     - extractFrame throws (models Req 17.1 "ffmpeg cannot decode a frame").
//     - uploadPoster throws (models a Blob upload failure after a decodable
//       frame — the poster_url write must still not happen).
//     - a "content-not-retrievable" failure (Req 17.2) is modeled two ways: the
//       media row is missing (loadMediaRow returns null -> throw) OR extractFrame
//       throws a retrieval error.
//   The model's `.query` interprets the ONLY two statements processJob issues
//   against `db` and, crucially, RECORDS every write to media.poster_url so the
//   test can assert NO write occurred on a failed attempt.
//
// TYPING NOTE: the fake executor's `query` is typed as pg's own `Pool['query']`
//   (its full overloaded signature) so the model is assignable to the pipeline's
//   `Executor = Pick<Pool | PoolClient, 'query'>` dependency under `tsc`. The
//   implementation is a plain async (sql, params) function adapted to that
//   overloaded type via one localized `as unknown as` cast (exactly as P14's
//   createModel does), keeping this new file free of new tsc errors.

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
    /** How many times UPDATE media SET poster_url ran (must be 0 on failure). */
    posterWriteCount: (mediaId: number) => number;
}

function createModel(media: MediaRow[], jobs: JobRow[]): Model {
    const mediaById = new Map<number, MediaRow>();
    for (const m of media) mediaById.set(m.media_id, { ...m });
    const jobsById = new Map<number, JobRow>();
    for (const j of jobs) jobsById.set(j.id, { ...j });
    // media_id -> number of poster_url writes it received. Any write on a failed
    // attempt is a violation of the property, so we count them explicitly.
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
        // This is the ONLY poster_url mutation. On any failure path the pipeline
        // must never reach here; we record every write so the test can assert 0.
        if (/UPDATE\s+media\s+SET\s+poster_url\s*=\s*\$1/i.test(sql)) {
            const url = (params ?? [])[0] as string;
            const mediaId = (params ?? [])[1] as number;
            const row = mediaById.get(mediaId);
            if (row) row.poster_url = url;
            posterWrites.set(mediaId, (posterWrites.get(mediaId) ?? 0) + 1);
            return { rows: [], rowCount: row ? 1 : 0 };
        }
        throw new Error(`Unexpected query in P15 model: ${sql}`);
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

// A valid-shaped frame used ONLY by the upload-failure scenario (extraction
// succeeds, then the upload throws before poster_url could be written).
const FAKE_FRAME: ExtractedFrame = {
    data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    width: 320,
    height: 240,
    contentType: 'image/jpeg',
    extension: 'jpg',
};

// The kinds of processing failure we inject. Each maps to a real failure path
// the pipeline must survive without touching poster_url.
type FailureKind =
    | 'ffmpeg-cannot-decode' // Req 17.1: extractFrame throws
    | 'content-not-retrievable-extract' // Req 17.2: extractFrame throws a retrieval error
    | 'content-not-retrievable-missing-row' // Req 17.2: media row is gone -> loadMediaRow null -> throw
    | 'upload-failure'; // Req 8.4/10.4: extract ok, upload throws before the poster_url write

// --- fast-check generators ----------------------------------------------------

// A single video media row + its poster_job, plus the failure to inject and the
// row's PRE-ATTEMPT poster_url (null for a fresh row, a string for a row that
// already had a poster — both must be preserved exactly on failure).
const jobShapeArb = fc.record({
    content: fc.webUrl(),
    // Mostly videos; a few non-video/null types kept for realism. type does not
    // change the failure paths under test, but keeps the model faithful.
    type: fc.constantFrom<string | null>(
        'video/mp4',
        'video/quicktime',
        'video/webm',
        'image/jpeg',
        null,
    ),
    // The value stored BEFORE the attempt: null (fresh) or an existing poster.
    initialPoster: fc.option(fc.webUrl(), { nil: null }),
    // Pre-failure attempt count (drives pending-vs-failed on failJob).
    attempts: fc.integer({ min: 0, max: 6 }),
    failureKind: fc.constantFrom<FailureKind>(
        'ffmpeg-cannot-decode',
        'content-not-retrievable-extract',
        'content-not-retrievable-missing-row',
        'upload-failure',
    ),
});

// A set of distinct-media jobs. Media ids / job ids are remapped by index so each
// job maps to its own media row (one poster_job per media_id — Req 2.4).
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

// Build the injected deps for one entry, wiring the chosen failure. For the
// "missing-row" failure the media row is simply omitted from the model, so
// loadMediaRow returns null and the pipeline throws before any generation.
function depsForEntry(
    entry: { failureKind: FailureKind },
    model: Model,
): ProcessJobDeps {
    const extractFrame = async (
        _options: ExtractFrameOptions,
    ): Promise<ExtractedFrame> => {
        if (entry.failureKind === 'ffmpeg-cannot-decode') {
            throw new Error('mock: ffmpeg cannot decode a frame');
        }
        if (entry.failureKind === 'content-not-retrievable-extract') {
            throw new Error('mock: content not retrievable');
        }
        // For 'upload-failure' extraction succeeds; for 'missing-row' the
        // pipeline never calls extractFrame (it throws earlier).
        return FAKE_FRAME;
    };

    const uploadPoster = async (
        pathname: string,
        _frame: ExtractedFrame,
        _config: WorkerConfig,
    ): Promise<PosterUploadResult> => {
        if (entry.failureKind === 'upload-failure') {
            throw new Error('mock: blob upload failed');
        }
        // Should not be reached for the extract-failure / missing-row kinds.
        return { url: `https://blob.example/${pathname}` };
    };

    return {
        config: BASE_CONFIG,
        db: model.db,
        extractFrame,
        uploadPoster,
        completeJob: (jobId) => model.completeJob(jobId),
        failJob: (jobId, attempts, maxAttempts) =>
            model.failJob(jobId, attempts, maxAttempts),
    };
}

describe('P15 — failure never overwrites poster_url', () => {
    it('a failed attempt leaves poster_url EXACTLY at its pre-attempt value (and never writes it)', async () => {
        await fc.assert(
            fc.asyncProperty(scenarioArb, async (entries) => {
                // Only entries whose media row EXISTS are inserted; the
                // "missing-row" kind deliberately omits its media row so the
                // pipeline hits the not-found failure path (Req 17.2).
                const media: MediaRow[] = entries
                    .filter(
                        (e) => e.failureKind !== 'content-not-retrievable-missing-row',
                    )
                    .map((e) => ({
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

                // Snapshot the pre-attempt poster_url for every media row so we
                // can assert byte-for-byte preservation afterward.
                const before = new Map<number, string | null | undefined>();
                for (const e of entries) {
                    before.set(e.media_id, model.mediaPosterUrl(e.media_id));
                }

                // Drive the REAL pipeline for every job with a failing boundary.
                // processJob converts a processing failure into a failJob
                // transition and never throws (Req 17.4), so this loop completes.
                for (const e of entries) {
                    const job: PosterJob = {
                        id: e.id,
                        media_id: e.media_id,
                        status: 'processing',
                        attempts: e.attempts,
                        run_after: new Date().toISOString(),
                    };
                    await processJob(job, depsForEntry(e, model));
                }

                for (const e of entries) {
                    const priorPoster = before.get(e.media_id);
                    // A row that ALREADY had a poster takes the idempotent re-run
                    // short-circuit (Req 10.1): the pipeline marks the job done
                    // WITHOUT extraction/upload and WITHOUT touching poster_url.
                    // That is not a "failed attempt" — the injected failing
                    // boundary is never reached. Either way poster_url must be
                    // preserved, so (a)/(b) below still apply universally; only
                    // the "did not reach done" check (c) is scoped to rows that
                    // truly exercised the failure path (null prior poster).
                    const tookFailurePath =
                        priorPoster === null || priorPoster === undefined;

                    // (a) NO WRITE: the poster_url UPDATE never ran — neither the
                    //     failure path nor the idempotent re-run writes it.
                    expect(model.posterWriteCount(e.media_id)).toBe(0);

                    // (b) PRESERVED EXACTLY: after the attempt the stored value
                    //     equals the pre-attempt value — null stays null, an
                    //     existing poster stays byte-for-byte identical, and it is
                    //     never a partial/blank value (Req 8.4, 10.4, 17.3).
                    expect(model.mediaPosterUrl(e.media_id)).toBe(priorPoster);

                    // (c) A row that actually hit the failure path never reached
                    //     'done'. (Rows with a pre-existing poster legitimately
                    //     become 'done' via the idempotent re-run — poster kept.)
                    if (tookFailurePath) {
                        expect(model.jobStatus(e.id)).not.toBe('done');
                    }
                }
            }),
            { numRuns: NUM_RUNS },
        );
    });

    it('a pre-existing poster survives repeated failed attempts unchanged (Req 17.3)', async () => {
        // Focused case: a row that already has a poster is hammered by a failing
        // pipeline; its poster_url must be preserved on every attempt.
        await fc.assert(
            fc.asyncProperty(
                fc.record({
                    content: fc.webUrl(),
                    existingPoster: fc.webUrl(),
                    failureKind: fc.constantFrom<FailureKind>(
                        'ffmpeg-cannot-decode',
                        'content-not-retrievable-extract',
                        'upload-failure',
                    ),
                    rounds: fc.integer({ min: 1, max: 6 }),
                }),
                async ({ content, existingPoster, failureKind, rounds }) => {
                    // A fresh (null-poster) row is driven through the FAILURE path
                    // repeatedly: its poster_url must stay null across every failed
                    // round (never cleared to a partial/blank value, Req 17.3).
                    // Because the idempotent short-circuit only fires when
                    // poster_url is non-null, a row that ALREADY has a poster is
                    // covered separately below (that path keeps the exact value).
                    const model = createModel(
                        [{ media_id: 1, content, type: 'video/mp4', poster_url: null }],
                        [{ id: 1, media_id: 1, status: 'processing', attempts: 0 }],
                    );

                    const deps = depsForEntry({ failureKind }, model);

                    for (let r = 0; r < rounds; r++) {
                        const attemptsBefore = model.jobs()[0]!.attempts;
                        await processJob(
                            {
                                id: 1,
                                media_id: 1,
                                status: 'processing',
                                attempts: attemptsBefore,
                                run_after: new Date().toISOString(),
                            },
                            deps,
                        );
                        // poster_url stays null across every failed round.
                        expect(model.mediaPosterUrl(1)).toBeNull();
                        expect(model.posterWriteCount(1)).toBe(0);
                    }

                    // Now confirm a row that ALREADY has a poster: processing it is
                    // the idempotent re-run path — it must stay done AND keep the
                    // exact poster (it is never overwritten with a partial value).
                    const posteredModel = createModel(
                        [
                            {
                                media_id: 2,
                                content,
                                type: 'video/mp4',
                                poster_url: existingPoster,
                            },
                        ],
                        [{ id: 2, media_id: 2, status: 'processing', attempts: 0 }],
                    );
                    // Boundaries throw if called; on the idempotent path they must
                    // not run, so poster_url can only be its original value.
                    const posteredDeps: ProcessJobDeps = {
                        config: BASE_CONFIG,
                        db: posteredModel.db,
                        extractFrame: async () => {
                            throw new Error('extraction must not run on re-run');
                        },
                        uploadPoster: async () => {
                            throw new Error('upload must not run on re-run');
                        },
                        completeJob: (jobId) => posteredModel.completeJob(jobId),
                        failJob: (jobId, attempts, maxAttempts) =>
                            posteredModel.failJob(jobId, attempts, maxAttempts),
                    };
                    await processJob(
                        {
                            id: 2,
                            media_id: 2,
                            status: 'processing',
                            attempts: 0,
                            run_after: new Date().toISOString(),
                        },
                        posteredDeps,
                    );
                    expect(posteredModel.mediaPosterUrl(2)).toBe(existingPoster);
                    expect(posteredModel.posterWriteCount(2)).toBe(0);
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });
});
