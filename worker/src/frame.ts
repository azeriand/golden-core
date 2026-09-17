// Frame extraction for the Poster_Worker (Requirements 8.1, 8.2, 17.1, 17.2).
//
// Given a video's public `content` URL, this module produces a single small
// poster image: it invokes the `ffmpeg` binary (provided at runtime by the
// worker's Docker image, Requirement 6.5), seeks an EARLY timestamp, decodes
// exactly one frame (`-frames:v 1`), and downscales it to at most
// POSTER_MAX_DIMENSION via the `scale` filter (Requirements 8.1, 8.2). The raw
// frame ffmpeg emits on stdout is then piped through `sharp` for the final,
// consistent small JPEG encode.
//
// Failure model (Requirements 17.1, 17.2): reading a remote video over HTTP or
// decoding a frame can fail for perfectly normal reasons -- the blob is not
// retrievable, or the container cannot be decoded at the requested seek point
// (e.g. a mobile recording whose moov atom lives at the tail). Those are NOT
// exceptional bugs; they are expected failure paths that must THROW so the
// per-job pipeline can route them to failJob and apply Retry_Backoff /
// Max_Attempts. Before giving up on the early seek, we attempt one bounded
// fallback that seeks to 0 (the very first frame), which succeeds for many files
// whose early-seek target lands on an undecodable point.
//
// This module reads no secrets. It receives only a public content URL and the
// max dimension, so nothing here can leak DATABASE_URL or BLOB_READ_WRITE_TOKEN
// (Requirements 14.3, 14.4).

import { spawn } from 'node:child_process';
import sharp from 'sharp';

/** The early timestamp we seek to first. A second in avoids all-black lead-ins. */
const EARLY_SEEK = '00:00:01';

/** The bounded fallback seek: the very first frame (Requirements 17.1, 17.2). */
const FALLBACK_SEEK = '0';

/** MIME type of the poster image this module produces. */
export const POSTER_CONTENT_TYPE = 'image/jpeg';

/** File extension (no dot) of the poster image this module produces. */
export const POSTER_EXTENSION = 'jpg';

/** Result of a successful frame extraction: the encoded poster bytes + metadata. */
export interface ExtractedFrame {
  /** Encoded poster image bytes (JPEG). */
  readonly data: Buffer;
  /** Final poster width in pixels (<= maxDimension). */
  readonly width: number;
  /** Final poster height in pixels (<= maxDimension). */
  readonly height: number;
  /** MIME content type of `data`. */
  readonly contentType: string;
  /** File extension (no dot) matching `data`. */
  readonly extension: string;
}

/**
 * Raised when a frame cannot be produced from the video. Carries only non-secret
 * context (the seek attempted and a short reason). The per-job pipeline treats
 * this as a normal job failure (Requirements 17.1, 17.2).
 */
export class FrameExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameExtractionError';
  }
}

/** Options controlling frame extraction. */
export interface ExtractFrameOptions {
  /** Public content URL of the video to read from. */
  readonly contentUrl: string;
  /** Max poster width/height in pixels (from config.maxDimension). */
  readonly maxDimension: number;
  /** Override the ffmpeg binary path/name (defaults to `ffmpeg` on PATH). */
  readonly ffmpegPath?: string;
}

/**
 * Run ffmpeg once, seeking `seek`, and return the raw single-frame bytes it
 * writes to stdout. Rejects with a FrameExtractionError when ffmpeg exits
 * non-zero (cannot retrieve the content or cannot decode a frame) or emits no
 * bytes.
 *
 * SEEK ORDERING (the .mov "no poster" fix): `-ss` is placed AFTER `-i` (output
 * seeking), NOT before it (input seeking). Fast input seeking assumes ffmpeg can
 * position the demuxer before fully parsing the container, which breaks for
 * QuickTime/iPhone recordings whose `moov` atom (the index ffmpeg needs to
 * decode) sits at the TAIL of the file rather than the front (no faststart).
 * Read over HTTP, an input `-ss` on such a file lands on an undecodable point
 * and ffmpeg exits non-zero — which is exactly what stranded these videos with
 * no poster. Output seeking opens `-i` first, so ffmpeg reads the container
 * (fetching the trailing `moov` via HTTP range requests — the Blob store sends
 * `accept-ranges: bytes`) and then discards frames up to `seek`. It reads more
 * bytes for a mid-clip seek, but it is correct for both faststart and
 * tail-moov files; since we only decode one early frame the extra cost is small.
 *
 * `-reconnect*` make the HTTP input resilient to transient drops/redirects on
 * the remote Blob so a flaky fetch retries in-process instead of failing the job.
 */
function runFfmpegSeek(
  seek: string,
  options: ExtractFrameOptions,
): Promise<Buffer> {
  const ffmpegPath = options.ffmpegPath ?? 'ffmpeg';

  // scale='min(MAXDIM,iw)':-2 caps width at maxDimension while preserving aspect
  // ratio (-2 keeps height even, required by many encoders). We emit an
  // uncompressed-ish mjpeg frame to stdout via image2pipe and let sharp perform
  // the final small JPEG encode downstream (Requirements 8.1, 8.2).
  const scaleFilter = `scale='min(${options.maxDimension},iw)':-2`;

  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    // Resilient HTTP input for remote Blob reads (ignored for file:// inputs).
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_on_network_error', '1',
    '-i', options.contentUrl,
    // Output seeking: AFTER -i so the container (incl. a tail moov) is parsed
    // before the seek. See the doc comment above for why this fixes .mov posters.
    '-ss', seek,
    '-frames:v', '1',
    '-vf', scaleFilter,
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    'pipe:1',
  ];

  return new Promise<Buffer>((resolve, reject) => {
    let child;
    try {
      child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(
        new FrameExtractionError(
          `failed to spawn ffmpeg (seek=${seek}): ${errText(err)}`,
        ),
      );
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('error', (err) => {
      // Spawn-time errors such as ENOENT (ffmpeg binary not found) surface here.
      reject(
        new FrameExtractionError(
          `ffmpeg process error (seek=${seek}): ${errText(err)}`,
        ),
      );
    });

    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks);
      if (code !== 0) {
        // Non-zero exit covers "content not retrievable" and "cannot decode a
        // frame" (Requirements 17.1, 17.2). stderr is short (loglevel error) and
        // secret-free (only the public URL + ffmpeg diagnostics).
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
        reject(
          new FrameExtractionError(
            `ffmpeg exited with code ${code} (seek=${seek})` +
              (stderr ? `: ${stderr}` : ''),
          ),
        );
        return;
      }
      if (stdout.length === 0) {
        reject(
          new FrameExtractionError(
            `ffmpeg produced no frame data (seek=${seek})`,
          ),
        );
        return;
      }
      resolve(stdout);
    });
  });
}

/** Normalize an unknown thrown value into a short, non-secret string. */
function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Extract a single early frame from the video at `contentUrl`, downscaled to at
 * most `maxDimension`, and return it as an encoded JPEG poster.
 *
 * Strategy (Requirements 8.1, 8.2, 17.1, 17.2):
 *   1. Try the early seek (EARLY_SEEK).
 *   2. If that fails, attempt one bounded fallback seeking to 0.
 *   3. If both fail, throw FrameExtractionError so the job fails cleanly.
 *
 * The raw frame from ffmpeg is passed through sharp for the final encode, which
 * also enforces the max-dimension cap defensively (in case the scale filter and
 * sharp disagree by a pixel) and yields the width/height of the produced image.
 */
export async function extractPosterFrame(
  options: ExtractFrameOptions,
): Promise<ExtractedFrame> {
  let rawFrame: Buffer;
  try {
    rawFrame = await runFfmpegSeek(EARLY_SEEK, options);
  } catch (earlyErr) {
    // Bounded fallback: seek to the very first frame before giving up. This
    // recovers files whose early-seek target is undecodable (Req 17.1, 17.2).
    try {
      rawFrame = await runFfmpegSeek(FALLBACK_SEEK, options);
    } catch (fallbackErr) {
      throw new FrameExtractionError(
        `could not extract a frame from video: early seek failed ` +
          `(${errText(earlyErr)}); fallback seek failed (${errText(fallbackErr)})`,
      );
    }
  }

  // Final encode via sharp keeps poster output consistent with the rest of the
  // app and defensively re-applies the max-dimension cap without enlarging
  // smaller frames (withoutEnlargement). fit: 'inside' preserves aspect ratio.
  try {
    const pipeline = sharp(rawFrame)
      .resize({
        width: options.maxDimension,
        height: options.maxDimension,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 80 });

    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });

    return {
      data,
      width: info.width,
      height: info.height,
      contentType: POSTER_CONTENT_TYPE,
      extension: POSTER_EXTENSION,
    };
  } catch (encodeErr) {
    // A frame that ffmpeg produced but sharp cannot decode is still an
    // unprocessable-video failure path (Requirement 17.1).
    throw new FrameExtractionError(
      `failed to encode extracted frame: ${errText(encodeErr)}`,
    );
  }
}
