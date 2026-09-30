// Video transcode pipeline: original URL -> ffmpeg -> Blob -> db.
//
// This module owns what happens to a SINGLE claimed media_jobs row of
// kind='video'. The goal (design Component 4, Req 4.1-4.6) is to produce a
// normalized, reduced display version of the uploaded ORIGINAL video and make it
// what the app serves, WITHOUT ever touching the preserved original:
//
//   claimed video job
//     -> load media row (content, original_url, type)
//     -> if content already points at the derivatives/{media_id}/ namespace:
//        completeJob (idempotent re-run — transcode already produced) (Req 4.6)
//     -> else transcode the ORIGINAL (original_url ?? content) with ffmpeg to
//        H.264/AAC MP4 capped at VIDEO_MAX_HEIGHT using VIDEO_CRF/VIDEO_PRESET
//        (Req 4.2)
//        -> upload the derivative under derivatives/{media_id}/video.mp4 and
//           UPDATE media SET content = <derivative> — the SINGLE final URL, only
//           after a successful upload, scoped to this one row (Req 4.3, 8.4)
//        -> completeJob (status 'done')
//   any thrown error PROPAGATES to the processJob wrapper, which applies the
//   shared failJob/backoff and leaves media.content (and original_url) UNCHANGED,
//   so the app keeps SERVING THE ORIGINAL on permanent failure (Req 4.5, 8.4,
//   17.3). A single bad video therefore fails cleanly without stalling others
//   (Req 5.4, 17.4).
//
// The ORIGINAL is never modified: original_url is read-only here and content is
// only ever rewritten to a freshly-uploaded transcode (Req 1.3, P5).
//
// TRANSCODE vs. the poster frame: unlike frame.ts (which decodes ONE early
// frame), a transcode must read and re-encode the WHOLE video, so it downloads
// the original to a temp file first (ffmpeg needs seekable input for many
// containers, and a single sequential read is cheaper than repeated HTTP range
// seeks over the whole file). The temp files are always cleaned up.
//
// SECRETS: BLOB_READ_WRITE_TOKEN reaches this module only through config
// (env-only) and is passed to the Blob `put` call as its `token` option. It is
// never logged (Req 14.3, 14.4).

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { put } from '@vercel/blob';
import type { Pool, PoolClient } from 'pg';

import type { WorkerConfig } from './config.js';
import { logger } from './logger.js';
import { DERIVATIVE_PREFIX, isDerivativeUrl } from './image-derivative.js';
import type { MediaJob } from './queue.js';

/** Minimal executor type (shared Pool OR a transaction client). */
type Executor = Pick<Pool | PoolClient, 'query'>;

/** The subset of a media row the video pipeline needs. */
interface VideoMediaRow {
  content: string;
  original_url: string | null;
  type: string | null;
}

/** Result of uploading a transcode to Blob: the single, final public URL. */
export interface TranscodeUploadResult {
  url: string;
}

/** An encoded video transcode produced by ffmpeg (MP4 bytes on disk/in memory). */
export interface EncodedVideo {
  readonly data: Buffer;
  readonly contentType: string;
  readonly extension: string;
}

/**
 * Raised when a video cannot be transcoded. Carries only non-secret context. The
 * processJob wrapper treats this as a normal job failure (Req 4.5, 17.1, 17.2).
 */
export class VideoTranscodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoTranscodeError';
  }
}

/**
 * Injectable collaborators for the video pipeline. Defaults wire the real
 * boundaries (fetch, ffmpeg, Vercel Blob put); tests override any subset to
 * exercise control flow (success, failure->fallback, idempotency) without
 * touching the network, ffmpeg, or Postgres.
 */
export interface VideoTranscodeDeps {
  readonly config: WorkerConfig;
  readonly db: Executor;
  /** Mark the job done (queue transition). Shared with the poster pipeline. */
  readonly completeJob: (jobId: number, db?: Executor) => Promise<void>;
  /** Transcode the original at `sourceUrl` to a reduced MP4; returns the bytes. */
  readonly transcode?: (
    sourceUrl: string,
    config: WorkerConfig,
  ) => Promise<EncodedVideo>;
  /** Upload the transcode bytes under `pathname`; returns the final URL. */
  readonly uploadTranscode?: (
    pathname: string,
    video: EncodedVideo,
    config: WorkerConfig,
  ) => Promise<TranscodeUploadResult>;
}

/** Normalize an unknown thrown value into a short, non-secret string. */
function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Default transcoder: download the original to a temp file, run ffmpeg to
 * produce an H.264/AAC MP4 downscaled so its height is at most
 * `config.videoMaxHeight` (width auto, kept even), at `config.videoCrf` with
 * `config.videoPreset`, with `+faststart` so the moov atom is at the front for
 * progressive playback. Reads the result into a Buffer and cleans up temp files.
 *
 * The scale filter `scale=-2:'min(HEIGHT,ih)'` caps height without enlarging and
 * keeps width even (-2), preserving aspect ratio. `-movflags +faststart`
 * relocates the index to the head so the served derivative streams immediately.
 */
async function defaultTranscode(
  sourceUrl: string,
  config: WorkerConfig,
): Promise<EncodedVideo> {
  const dir = await mkdtemp(join(tmpdir(), 'transcode-'));
  const inputPath = join(dir, 'input');
  const outputPath = join(dir, 'output.mp4');

  try {
    // 1. Download the original to a seekable temp file. A non-OK response or
    //    network error throws -> clean job failure (Req 4.5, 17.1).
    const res = await fetch(sourceUrl);
    if (!res.ok) {
      throw new VideoTranscodeError(
        `failed to fetch original video: HTTP ${res.status}`,
      );
    }
    const inputBytes = Buffer.from(await res.arrayBuffer());
    await writeFile(inputPath, inputBytes);

    // 2. Transcode with ffmpeg (Req 4.2).
    const scaleFilter = `scale=-2:'min(${config.videoMaxHeight},ih)'`;
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', inputPath,
      '-vf', scaleFilter,
      '-c:v', 'libx264',
      '-preset', config.videoPreset,
      '-crf', String(config.videoCrf),
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      '-y',
      outputPath,
    ];

    await runFfmpeg(args);

    // 3. Read the produced MP4 back into memory for upload.
    const outputBytes = await readFile(outputPath);
    if (outputBytes.length === 0) {
      throw new VideoTranscodeError('ffmpeg produced an empty output file');
    }

    return {
      data: outputBytes,
      contentType: 'video/mp4',
      extension: 'mp4',
    };
  } finally {
    // Always clean up the temp directory (both files), best-effort.
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Run ffmpeg with the given args; reject with a VideoTranscodeError on failure. */
function runFfmpeg(args: string[], ffmpegPath = 'ffmpeg'): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let child;
    try {
      child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      reject(new VideoTranscodeError(`failed to spawn ffmpeg: ${errText(err)}`));
      return;
    }

    const stderrChunks: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('error', (err) => {
      reject(new VideoTranscodeError(`ffmpeg process error: ${errText(err)}`));
    });

    child.on('close', (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
        reject(
          new VideoTranscodeError(
            `ffmpeg exited with code ${code}` + (stderr ? `: ${stderr}` : ''),
          ),
        );
        return;
      }
      resolve();
    });
  });
}

/**
 * Default Blob uploader: upload the transcode to Vercel Blob as a PUBLIC object
 * at `pathname`, authenticated with BLOB_READ_WRITE_TOKEN from config (env-only).
 * `allowOverwrite` lets a safe re-run rewrite the same deterministic key.
 */
async function defaultUploadTranscode(
  pathname: string,
  video: EncodedVideo,
  config: WorkerConfig,
): Promise<TranscodeUploadResult> {
  const result = await put(pathname, video.data, {
    access: 'public',
    contentType: video.contentType,
    token: config.blobReadWriteToken,
    allowOverwrite: true,
    addRandomSuffix: false,
  });
  return { url: result.url };
}

/**
 * Compute the deterministic Blob pathname for a media row's video transcode,
 * namespaced by media_id (mirrors imageDerivativePath).
 */
export function videoTranscodePath(mediaId: number): string {
  return `${DERIVATIVE_PREFIX}${mediaId}/video.mp4`;
}

/** Load the media row backing a video job (null when the row is gone). */
async function loadVideoMediaRow(
  db: Executor,
  mediaId: number,
): Promise<VideoMediaRow | null> {
  const result = await db.query<VideoMediaRow>(
    `SELECT content, original_url, type FROM media WHERE media_id = $1`,
    [mediaId],
  );
  return result.rows[0] ?? null;
}

/**
 * Run a single claimed video-transcode job. See the module header for the full
 * control flow. Errors PROPAGATE to the processJob wrapper (shared failJob /
 * backoff); this function does not catch them, so on permanent failure the app
 * keeps serving the original (Req 4.5, 8.4, 17.3).
 */
export async function runVideoTranscodeJob(
  job: MediaJob,
  deps: VideoTranscodeDeps,
): Promise<void> {
  const { config, db } = deps;
  const transcode = deps.transcode ?? defaultTranscode;
  const uploadTranscode = deps.uploadTranscode ?? defaultUploadTranscode;

  const media = await loadVideoMediaRow(db, job.media_id);
  if (media === null) {
    throw new Error(`media row not found for media_id=${job.media_id}`);
  }

  // Processing idempotency (Req 4.6): if content already points at the
  // derivative namespace, a transcode was already produced. Mark done without
  // regenerating.
  if (isDerivativeUrl(media.content)) {
    await deps.completeJob(job.id, db);
    logger.done(job.media_id, job.id);
    return;
  }

  // Transcode the ORIGINAL. Prefer original_url; fall back to content for legacy
  // rows. The original is never modified.
  const sourceUrl = media.original_url ?? media.content;
  const derivative = await transcode(sourceUrl, config);

  // Upload under a media_id-namespaced path (Req 4.3). Final URL known only
  // after this resolves.
  const pathname = videoTranscodePath(job.media_id);
  const upload = await uploadTranscode(pathname, derivative, config);

  // Record the SINGLE final transcode URL as the served content, only after a
  // successful upload, scoped to this one row (Req 4.3, 8.4). original_url is
  // deliberately NOT touched — the original is preserved (Req 1.3, P5).
  await db.query(`UPDATE media SET content = $1 WHERE media_id = $2`, [
    upload.url,
    job.media_id,
  ]);

  await deps.completeJob(job.id, db);
  logger.done(job.media_id, job.id);
}
