// Image display-derivative pipeline: original URL -> sharp downscale -> Blob -> db.
//
// This module owns what happens to a SINGLE claimed media_jobs row of
// kind='image'. The goal (design Component 4, Req 3.1-3.6) is to produce a
// reduced, re-encoded display version of the uploaded ORIGINAL image and make it
// what the app serves, WITHOUT ever touching the preserved original:
//
//   claimed image job
//     -> load media row (content, original_url, type)
//     -> if content already points at the derivatives/{media_id}/ namespace:
//        completeJob (idempotent re-run — derivative already produced) (Req 3.6)
//     -> else fetch the ORIGINAL bytes (original_url ?? content), downscale with
//        sharp to <= IMAGE_MAX_DIMENSION (fit inside, never enlarge), re-encode
//        at IMAGE_QUALITY (Req 3.2, 3.4)
//        -> if the derivative is NOT smaller than the original, keep serving the
//           original (never bloat) and still completeJob (Req 3.5)
//        -> else upload the derivative under derivatives/{media_id}/image.<ext>
//           and UPDATE media SET content = <derivative> — the SINGLE final URL,
//           only after a successful upload, scoped to this one row (Req 3.3, 8.4)
//        -> completeJob (status 'done')
//   any thrown error PROPAGATES to the processJob wrapper, which applies the
//   shared failJob/backoff and leaves media.content (and original_url) UNCHANGED,
//   so the app keeps serving the original on permanent failure (Req 8.4, 17.3).
//
// The ORIGINAL is never modified: original_url is read-only here and content is
// only ever rewritten to a freshly-uploaded derivative (Req 1.3, P5).
//
// SECRETS: BLOB_READ_WRITE_TOKEN reaches this module only through config
// (env-only) and is passed to the Blob `put` call as its `token` option. It is
// never logged (Req 14.3, 14.4).

import { put } from '@vercel/blob';
import sharp from 'sharp';
import type { Pool, PoolClient } from 'pg';

import type { WorkerConfig } from './config.js';
import { logger } from './logger.js';
import type { MediaJob } from './queue.js';

/** Minimal executor type (shared Pool OR a transaction client). */
type Executor = Pick<Pool | PoolClient, 'query'>;

/**
 * The Blob path prefix under which ALL worker-produced display derivatives live,
 * namespaced by media_id. The presence of this prefix in media.content is the
 * idempotency signal "a derivative has already been produced for this row"
 * (Req 3.6, mirrors the poster pipeline's "poster_url already set" guard).
 */
export const DERIVATIVE_PREFIX = 'derivatives/';

/** The subset of a media row the image pipeline needs. */
interface ImageMediaRow {
  /** The URL the app currently serves (original until a derivative lands). */
  content: string;
  /** The preserved original's URL (read-only here); may be null on legacy rows. */
  original_url: string | null;
  /** MIME type stored on the row (e.g. 'image/jpeg'). */
  type: string | null;
}

/** Result of uploading a derivative to Blob: the single, final public URL. */
export interface DerivativeUploadResult {
  url: string;
}

/**
 * Injectable collaborators for the image pipeline. Defaults wire the real
 * boundaries (global fetch, sharp, Vercel Blob put); tests override any subset
 * to exercise control flow (sizing, never-enlarge, atomic write, idempotency)
 * without touching the network, sharp, or Postgres.
 */
export interface ImageDerivativeDeps {
  readonly config: WorkerConfig;
  readonly db: Executor;
  /** Mark the job done (queue transition). Shared with the poster pipeline. */
  readonly completeJob: (jobId: number, db?: Executor) => Promise<void>;
  /** Fetch the original image bytes from a public URL. Defaults to global fetch. */
  readonly fetchOriginal?: (url: string) => Promise<Buffer>;
  /** Downscale/re-encode the original; returns the derivative bytes + metadata. */
  readonly encodeDerivative?: (
    input: Buffer,
    maxDimension: number,
    quality: number,
  ) => Promise<EncodedImage>;
  /** Upload the derivative bytes under `pathname`; returns the final URL. */
  readonly uploadDerivative?: (
    pathname: string,
    image: EncodedImage,
    config: WorkerConfig,
  ) => Promise<DerivativeUploadResult>;
}

/** An encoded image derivative produced by sharp. */
export interface EncodedImage {
  readonly data: Buffer;
  readonly contentType: string;
  /** File extension without the dot (e.g. 'jpg', 'webp'). */
  readonly extension: string;
  readonly width: number;
  readonly height: number;
}

/**
 * Default original fetcher: read the public Blob URL with global fetch and
 * return the bytes. A non-OK response or network error throws so the job fails
 * cleanly (Req 17.1 semantics for "content not retrievable").
 */
async function defaultFetchOriginal(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`failed to fetch original image: HTTP ${res.status}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Default encoder: downscale to at most `maxDimension` on the longest edge
 * preserving aspect ratio, never enlarging smaller images, and re-encode to a
 * space-efficient WebP at `quality`. WebP is a broadly-supported, smaller
 * delivery format that `next/image` can further negotiate on top of. The
 * original's format is irrelevant to the derivative — the derivative is purely a
 * display artifact (the original is preserved separately).
 */
async function defaultEncodeDerivative(
  input: Buffer,
  maxDimension: number,
  quality: number,
): Promise<EncodedImage> {
  const pipeline = sharp(input)
    // EXIF orientation is baked into the pixels so the derivative renders
    // upright regardless of the original's orientation tag.
    .rotate()
    .resize({
      width: maxDimension,
      height: maxDimension,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality });

  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  return {
    data,
    contentType: 'image/webp',
    extension: 'webp',
    width: info.width,
    height: info.height,
  };
}

/**
 * Default Blob uploader: upload the derivative to Vercel Blob as a PUBLIC object
 * at `pathname`, authenticated with BLOB_READ_WRITE_TOKEN from config (env-only).
 * `allowOverwrite` lets a safe re-run rewrite the same deterministic key.
 */
async function defaultUploadDerivative(
  pathname: string,
  image: EncodedImage,
  config: WorkerConfig,
): Promise<DerivativeUploadResult> {
  const result = await put(pathname, image.data, {
    access: 'public',
    contentType: image.contentType,
    token: config.blobReadWriteToken,
    allowOverwrite: true,
    addRandomSuffix: false,
  });
  return { url: result.url };
}

/**
 * Compute the deterministic Blob pathname for a media row's image derivative,
 * namespaced by media_id so derivatives never collide and a re-run overwrites
 * the same key rather than accumulating duplicates (mirrors posterBlobPath).
 */
export function imageDerivativePath(mediaId: number, extension: string): string {
  return `${DERIVATIVE_PREFIX}${mediaId}/image.${extension}`;
}

/** True when a URL already points at the worker's derivative namespace. */
export function isDerivativeUrl(url: string | null | undefined): boolean {
  return typeof url === 'string' && url.includes(`/${DERIVATIVE_PREFIX}`);
}

/** Load the media row backing an image job (null when the row is gone). */
async function loadImageMediaRow(
  db: Executor,
  mediaId: number,
): Promise<ImageMediaRow | null> {
  const result = await db.query<ImageMediaRow>(
    `SELECT content, original_url, type FROM media WHERE media_id = $1`,
    [mediaId],
  );
  return result.rows[0] ?? null;
}

/**
 * Run a single claimed image-derivative job. See the module header for the full
 * control flow. Errors PROPAGATE to the processJob wrapper (shared failJob /
 * backoff); this function does not catch them (Req 17.3, 8.4).
 */
export async function runImageDerivativeJob(
  job: MediaJob,
  deps: ImageDerivativeDeps,
): Promise<void> {
  const { config, db } = deps;
  const fetchOriginal = deps.fetchOriginal ?? defaultFetchOriginal;
  const encodeDerivative = deps.encodeDerivative ?? defaultEncodeDerivative;
  const uploadDerivative = deps.uploadDerivative ?? defaultUploadDerivative;

  const media = await loadImageMediaRow(db, job.media_id);
  if (media === null) {
    throw new Error(`media row not found for media_id=${job.media_id}`);
  }

  // Processing idempotency (Req 3.6): if content already points at the
  // derivative namespace, a derivative was already produced (e.g. a crash after
  // the UPDATE but before completeJob). Mark done without regenerating.
  if (isDerivativeUrl(media.content)) {
    await deps.completeJob(job.id, db);
    logger.done(job.media_id, job.id);
    return;
  }

  // Read the ORIGINAL bytes. Prefer original_url (the preserved original) and
  // fall back to content for legacy rows where original_url is null (content is
  // then the only version). The original is never modified.
  const originalUrl = media.original_url ?? media.content;
  const originalBytes = await fetchOriginal(originalUrl);

  // Downscale + re-encode (Req 3.2, 3.4). Never enlarges (handled in the encoder).
  const derivative = await encodeDerivative(
    originalBytes,
    config.imageMaxDimension,
    config.imageQuality,
  );

  // Never bloat (Req 3.5): if the derivative is not smaller than the original,
  // keep serving the original and still complete the job. No upload, no content
  // rewrite — the original stays the served version.
  if (derivative.data.length >= originalBytes.length) {
    await deps.completeJob(job.id, db);
    logger.done(job.media_id, job.id);
    return;
  }

  // Upload under a media_id-namespaced path (Req 3.3). Final URL known only
  // after this resolves.
  const pathname = imageDerivativePath(job.media_id, derivative.extension);
  const upload = await uploadDerivative(pathname, derivative, config);

  // Record the SINGLE final derivative URL as the served content, only after a
  // successful upload, scoped to this one row (Req 3.3, 8.4). original_url is
  // deliberately NOT touched — the original is preserved (Req 1.3, P5).
  await db.query(`UPDATE media SET content = $1 WHERE media_id = $2`, [
    upload.url,
    job.media_id,
  ]);

  await deps.completeJob(job.id, db);
  logger.done(job.media_id, job.id);
}
