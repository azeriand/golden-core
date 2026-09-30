// Poster_Worker per-job pipeline: content URL -> ffmpeg -> Blob -> db.
//
// This module owns what happens to a SINGLE claimed Poster_Job after the queue
// hands it over. The queue (queue.ts) has already flipped the job to
// 'processing'; this module drives the job to a terminal outcome:
//
//   claimed job
//     -> load media row (content, type, poster_url)
//     -> if poster_url already present: completeJob (idempotent re-run, Req 10.1)
//     -> else extract an early frame (frame.ts, Req 8.1/8.2)
//        -> upload the poster to Vercel Blob under posters/{media_id}/... (Req 8.3, 8.6)
//        -> UPDATE media SET poster_url = <final url> (single value, only after a
//           successful upload, never partial) (Req 8.4, 10.3, 10.4)
//        -> completeJob (status 'done') (Req 8.5)
//   any thrown error -> failJob (increment attempts, backoff or 'failed'), and the
//   media poster_url is LEFT UNCHANGED (Req 17.3, 8.4).
//
// TESTABILITY: every effectful boundary (frame extraction, Blob upload, db
// access, and the queue transitions) is injected through the `deps` argument.
// The default deps wire the real implementations, but downstream property tests
// (9.2-9.5) supply in-memory/mocked boundaries so the pipeline's control flow
// can be exercised over randomized inputs without touching ffmpeg, the network,
// or Postgres.
//
// SECRETS: BLOB_READ_WRITE_TOKEN reaches this module only through config
// (loadConfig, env-only) and is passed to the Blob `put` call as its `token`
// option. It is never logged -- the logger helpers accept only non-secret
// context (media_id, job id, attempts, short error strings) (Req 14.3, 14.4).

import { put } from '@vercel/blob';
import type { Pool, PoolClient } from 'pg';
import { loadConfig, type WorkerConfig } from './config.js';
import { getPool } from './db.js';
import {
  extractPosterFrame,
  type ExtractedFrame,
  type ExtractFrameOptions,
} from './frame.js';
import { logger } from './logger.js';
import {
  completeJob as defaultCompleteJob,
  failJob as defaultFailJob,
  type MediaJob,
  type PosterJob,
} from './queue.js';
import {
  runImageDerivativeJob,
  type ImageDerivativeDeps,
} from './image-derivative.js';
import {
  runVideoTranscodeJob,
  type VideoTranscodeDeps,
} from './video-transcode.js';

/**
 * Minimal executor type so the media read/update work against the shared worker
 * Pool OR a transaction client (both expose `.query` with the same signature).
 */
type Executor = Pick<Pool | PoolClient, 'query'>;

/** The subset of a media row this pipeline needs to make its decisions. */
interface MediaRow {
  /** Public Blob URL of the source video (ffmpeg input). */
  content: string;
  /** MIME type stored on the row (e.g. 'video/mp4'). */
  type: string | null;
  /** Existing poster URL, or null when no poster is ready yet. */
  poster_url: string | null;
}

/**
 * Result of uploading a poster image to Blob storage: the single, final public
 * URL to record on the media row. Modeled as its own type so the injected
 * uploader can be mocked without pulling in the whole @vercel/blob result shape.
 */
export interface PosterUploadResult {
  /** Final, public poster URL to store in media.poster_url. */
  url: string;
}

/**
 * Injectable collaborators for the pipeline. Defaults wire the real worker
 * modules; tests override any subset to mock effectful boundaries (Req: enables
 * property tests 9.2-9.5 without ffmpeg/network/Postgres).
 */
export interface ProcessJobDeps {
  /** Resolved worker configuration (max dimension, max attempts, backoff, token). */
  readonly config: WorkerConfig;
  /** DB executor for reading the media row and writing poster_url. */
  readonly db: Executor;
  /** Extract a downscaled poster frame from a video content URL. */
  readonly extractFrame: (options: ExtractFrameOptions) => Promise<ExtractedFrame>;
  /** Upload the poster bytes to storage under `pathname`; returns the final URL. */
  readonly uploadPoster: (
    pathname: string,
    frame: ExtractedFrame,
    config: WorkerConfig,
  ) => Promise<PosterUploadResult>;
  /** Mark the job done (queue transition to 'done'). */
  readonly completeJob: (jobId: number, db?: Executor) => Promise<void>;
  /** Handle a processing failure (increment attempts; backoff or 'failed'). */
  readonly failJob: (
    jobId: number,
    attempts: number,
    maxAttempts: number,
    backoffBaseSeconds: number,
    db?: Executor,
  ) => Promise<void>;
}

/**
 * Compute the deterministic Blob pathname for a media row's poster. The path is
 * namespaced by media_id so posters never collide and a re-run overwrites the
 * same key rather than accumulating duplicates (Req 8.6). The extension comes
 * from the produced frame (jpg) so the content type matches the stored bytes.
 */
export function posterBlobPath(mediaId: number, extension: string): string {
  return `posters/${mediaId}/poster.${extension}`;
}

/**
 * Default Blob uploader: upload the encoded poster to Vercel Blob as a PUBLIC
 * object at `pathname`, authenticated with BLOB_READ_WRITE_TOKEN from config
 * (env-only secret). `allowOverwrite` lets a safe re-run rewrite the same key.
 * Returns only the final public URL (Req 8.3, 8.4).
 */
async function defaultUploadPoster(
  pathname: string,
  frame: ExtractedFrame,
  config: WorkerConfig,
): Promise<PosterUploadResult> {
  const result = await put(pathname, frame.data, {
    access: 'public',
    contentType: frame.contentType,
    token: config.blobReadWriteToken,
    allowOverwrite: true,
    addRandomSuffix: false,
  });
  return { url: result.url };
}

/**
 * Build the default dependency set from the resolved config and shared Pool.
 * Callers that don't need to override anything can `processJob(job)` and get the
 * real pipeline; tests pass an explicit `deps` to inject mocks.
 */
export function defaultDeps(
  config: WorkerConfig = loadConfig(),
  db: Executor = getPool(),
): ProcessJobDeps {
  return {
    config,
    db,
    extractFrame: extractPosterFrame,
    uploadPoster: defaultUploadPoster,
    completeJob: defaultCompleteJob,
    failJob: defaultFailJob,
  };
}

/**
 * Load the media row backing a job. Returns null when the row is missing (a job
 * whose media row was deleted): the caller treats that as a clean failure so the
 * retry/backoff machinery drains the job rather than crashing the worker.
 */
async function loadMediaRow(
  db: Executor,
  mediaId: number,
): Promise<MediaRow | null> {
  const result = await db.query<MediaRow>(
    `SELECT content, type, poster_url FROM media WHERE media_id = $1`,
    [mediaId],
  );
  return result.rows[0] ?? null;
}

/**
 * Process a single claimed Media_Job end to end, dispatching by `job.kind`.
 *
 * This is the top of the per-job pipeline. It owns the cross-cutting concerns
 * that are IDENTICAL for every kind — claim-time logging, and the failure
 * contract that converts any thrown error into a failJob transition + a
 * secret-free failure log — and delegates the kind-specific body to a handler:
 *
 *   - 'poster' -> processPosterJob  (ffmpeg early frame -> media.poster_url)
 *   - 'image'  -> runImageDerivativeJob (sharp downscale -> media.content)
 *   - 'video'  -> runVideoTranscodeJob  (ffmpeg transcode -> media.content)
 *
 * Each handler is responsible ONLY for its success path and its idempotency
 * check; it lets errors propagate so this wrapper applies the shared
 * retry/backoff (Req 9.1-9.4) and never touches the derivative/poster column on
 * failure (Req 17.3, 8.4). Because the wrapper catches, `processJob` NEVER throws
 * for a normal processing failure, so one bad job cannot crash the poll loop or
 * stall other jobs (Req 5.4, 17.4).
 */
export async function processJob(
  job: MediaJob,
  deps: ProcessJobDeps = defaultDeps(),
): Promise<void> {
  const { config, db } = deps;

  // Claim-time observability: media_id + the pending -> processing transition,
  // emitted before work begins (Req 16.1). The queue already performed the
  // DB-side transition; this records it in the log stream.
  logger.claim(job.media_id, job.id, job.attempts);

  try {
    switch (job.kind) {
      case 'poster':
        await processPosterJob(job, deps);
        break;
      case 'image':
        await runImageDerivativeJob(job, imageDepsFrom(deps));
        break;
      case 'video':
        await runVideoTranscodeJob(job, videoDepsFrom(deps));
        break;
      default: {
        // Exhaustiveness guard: an unknown kind is a clean, drainable failure
        // (the CHECK constraint should prevent this, but the worker must not
        // crash if it ever occurs).
        const unknownKind: string = (job as MediaJob).kind;
        throw new Error(`unknown media job kind: ${unknownKind}`);
      }
    }
  } catch (err) {
    // Any failure (missing row, ffmpeg, sharp, upload, db write, unknown kind)
    // routes here. failJob increments attempts and either reschedules with
    // backoff or marks the job 'failed' at Max_Attempts (Req 9.1-9.4). We do NOT
    // touch the media derivative/poster column on failure, so a prior value is
    // preserved and a fresh row stays as-is (Req 17.3, 8.4).
    await deps.failJob(
      job.id,
      job.attempts,
      config.maxAttempts,
      config.backoffBaseSeconds,
      db,
    );

    // Determine the resulting status for the log line: 'failed' once the
    // incremented attempts reach Max_Attempts, otherwise a retryable 'pending'
    // (mirrors failJob's own CASE) (Req 16.3).
    const nextStatus =
      job.attempts + 1 >= config.maxAttempts ? 'failed' : 'pending';
    logger.failure(job.media_id, job.id, job.attempts + 1, nextStatus, err);
  }
}

/**
 * Poster pipeline (unchanged behavior, extracted from the former processJob).
 *
 * Control flow (Req 8.3-8.6, 10.1, 10.3, 10.4):
 *   1. Load the media row.
 *   2. If the media row already has a non-null poster_url, this is a safe re-run
 *      (crash/timeout reclaim): mark the job done WITHOUT regenerating and
 *      WITHOUT touching poster_url (Req 10.1, 10.3, 10.4).
 *   3. Otherwise extract an early frame, upload the poster under
 *      posters/{media_id}/poster.<ext>, then write the SINGLE final URL to
 *      media.poster_url only after the upload succeeds (never a partial value),
 *      and mark the job done (Req 8.3, 8.4, 8.5, 8.6).
 *
 * Errors are allowed to PROPAGATE to the processJob wrapper, which applies the
 * shared failJob/backoff and leaves poster_url untouched (Req 17.3).
 */
export async function processPosterJob(
  job: MediaJob,
  deps: ProcessJobDeps,
): Promise<void> {
  const { config, db } = deps;

  const media = await loadMediaRow(db, job.media_id);
  if (media === null) {
    // No media row to work from -> unprocessable; fail cleanly so retry/backoff
    // eventually drains the job (Req 17.2 semantics for "not retrievable").
    throw new Error(`media row not found for media_id=${job.media_id}`);
  }

  // Processing idempotency: a re-run after a crash/timeout must not regenerate
  // or overwrite an existing poster. If poster_url is already set, the job is
  // effectively done (Req 10.1, 10.3, 10.4).
  if (media.poster_url !== null && media.poster_url !== '') {
    await deps.completeJob(job.id, db);
    logger.done(job.media_id, job.id);
    return;
  }

  // Extract an early, downscaled frame from the video content URL (Req 8.1,
  // 8.2). A failure here (content not retrievable / cannot decode) throws and
  // is handled by the processJob wrapper (Req 17.1, 17.2).
  const frame = await deps.extractFrame({
    contentUrl: media.content,
    maxDimension: config.maxDimension,
  });

  // Upload the poster under a media_id-namespaced path (Req 8.3, 8.6). The
  // final public URL is known only after this resolves.
  const pathname = posterBlobPath(job.media_id, frame.extension);
  const upload = await deps.uploadPoster(pathname, frame, config);

  // Record the SINGLE final poster URL, only after a successful upload, never a
  // partial value (Req 8.4, 10.3, 10.4). Scoped by media_id so no other row is
  // touched.
  await db.query(`UPDATE media SET poster_url = $1 WHERE media_id = $2`, [
    upload.url,
    job.media_id,
  ]);

  // Mark the job done now that poster_url is persisted (Req 8.5). A 'done' job
  // therefore always corresponds to a non-null poster_url.
  await deps.completeJob(job.id, db);
  logger.done(job.media_id, job.id);
}

/**
 * Adapt the shared ProcessJobDeps into the narrower dependency set the image
 * derivative handler needs (config, db, and the queue transitions). The image
 * handler owns its own fetch/sharp/upload boundaries with their own defaults, so
 * only the shared collaborators are threaded through here (keeps the poster
 * pipeline's injected mocks working unchanged in tests).
 */
function imageDepsFrom(deps: ProcessJobDeps): ImageDerivativeDeps {
  return {
    config: deps.config,
    db: deps.db,
    completeJob: deps.completeJob,
  };
}

/**
 * Adapt the shared ProcessJobDeps into the video transcode handler's dependency
 * set (config, db, and the queue transitions). The video handler owns its own
 * ffmpeg/upload boundaries.
 */
function videoDepsFrom(deps: ProcessJobDeps): VideoTranscodeDeps {
  return {
    config: deps.config,
    db: deps.db,
    completeJob: deps.completeJob,
  };
}
