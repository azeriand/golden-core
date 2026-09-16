// Unit test for frame extraction against a real fixture video (Task 8.2).
//
// This exercises `extractPosterFrame` end-to-end through the REAL ffmpeg binary
// and the REAL sharp encode (no mocking of the effectful boundary): given a
// small fixture video, it must produce a non-empty JPEG poster whose dimensions
// are both <= POSTER_MAX_DIMENSION (Requirements 8.1, 8.2). It also asserts that
// unreachable and undecodable inputs are surfaced as FrameExtractionError so the
// per-job pipeline can fail the job cleanly (Requirements 17.1, 17.2).
//
// ffmpeg availability: the live-extraction assertions require the `ffmpeg`
// binary (provided at runtime by the worker's Docker image, Requirement 6.5).
// When ffmpeg is NOT on PATH in the current environment, those assertions are
// skipped with a clear console note; the "throws on bad input" assertions still
// run because a missing ffmpeg binary itself causes extraction to throw
// FrameExtractionError (the same error class the pipeline treats as a failure).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  extractPosterFrame,
  FrameExtractionError,
  POSTER_CONTENT_TYPE,
  POSTER_EXTENSION,
} from '../src/frame.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const FIXTURE_VIDEO = path.join(FIXTURES_DIR, 'sample.mp4');

/** Max poster dimension used for the test (matches a small POSTER_MAX_DIMENSION). */
const MAX_DIMENSION = 320;

/** True when the `ffmpeg` binary can be spawned in this environment. */
function ffmpegAvailable(): boolean {
  try {
    const res = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return res.status === 0;
  } catch {
    return false;
  }
}

const HAS_FFMPEG = ffmpegAvailable();

// A `file://` URL for the fixture. ffmpeg accepts local paths and file:// URLs
// as input; the extractor passes contentUrl straight to `-i`.
function fixtureUrl(): string {
  return `file://${FIXTURE_VIDEO}`;
}

// Generate a tiny fixture video with ffmpeg's built-in `testsrc` source once,
// before the live-extraction test. The clip is deliberately small: 2 seconds,
// 160x120, low frame rate. Kept out of source control (generated on demand).
beforeAll(() => {
  if (!HAS_FFMPEG) {
    // eslint-disable-next-line no-console
    console.warn(
      '[frame-extraction.test] ffmpeg is not available on PATH; ' +
        'skipping live extraction assertions. The fixture cannot be generated ' +
        'and extractPosterFrame cannot run the real binary in this environment.',
    );
    return;
  }

  mkdirSync(FIXTURES_DIR, { recursive: true });

  if (!existsSync(FIXTURE_VIDEO)) {
    const res = spawnSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-y',
        '-f', 'lavfi',
        '-i', 'testsrc=duration=2:size=160x120:rate=10',
        '-pix_fmt', 'yuv420p',
        FIXTURE_VIDEO,
      ],
      { stdio: 'inherit' },
    );
    if (res.status !== 0) {
      throw new Error(
        `failed to generate fixture video with ffmpeg (status=${res.status})`,
      );
    }
  }
});

describe('extractPosterFrame', () => {
  it.runIf(HAS_FFMPEG)(
    'produces a non-empty JPEG downscaled to <= POSTER_MAX_DIMENSION from a fixture video',
    async () => {
      const frame = await extractPosterFrame({
        contentUrl: fixtureUrl(),
        maxDimension: MAX_DIMENSION,
      });

      // Non-empty encoded poster bytes.
      expect(frame.data).toBeInstanceOf(Buffer);
      expect(frame.data.length).toBeGreaterThan(0);

      // Reported metadata matches the JPEG poster contract (Requirement 8.2).
      expect(frame.contentType).toBe(POSTER_CONTENT_TYPE);
      expect(frame.extension).toBe(POSTER_EXTENSION);

      // Reported dimensions are within the cap (Requirement 8.2).
      expect(frame.width).toBeGreaterThan(0);
      expect(frame.height).toBeGreaterThan(0);
      expect(frame.width).toBeLessThanOrEqual(MAX_DIMENSION);
      expect(frame.height).toBeLessThanOrEqual(MAX_DIMENSION);

      // Independently decode the produced bytes to confirm they are a real image
      // whose actual pixel dimensions are within the cap (defense against the
      // reported metadata drifting from the encoded output).
      const meta = await sharp(frame.data).metadata();
      expect(meta.format).toBe('jpeg');
      expect(meta.width ?? 0).toBeGreaterThan(0);
      expect(meta.height ?? 0).toBeGreaterThan(0);
      expect(meta.width ?? Infinity).toBeLessThanOrEqual(MAX_DIMENSION);
      expect(meta.height ?? Infinity).toBeLessThanOrEqual(MAX_DIMENSION);
    },
  );

  it.runIf(HAS_FFMPEG)(
    'downscales a large source frame so neither dimension exceeds the cap',
    async () => {
      // The testsrc fixture is 160x120 (smaller than the cap), which verifies
      // withoutEnlargement keeps small frames small. Also generate one LARGER
      // than the cap to prove the scale-down path honors POSTER_MAX_DIMENSION.
      const bigFixture = path.join(FIXTURES_DIR, 'sample-big.mp4');
      if (!existsSync(bigFixture)) {
        const res = spawnSync(
          'ffmpeg',
          [
            '-hide_banner',
            '-loglevel', 'error',
            '-y',
            '-f', 'lavfi',
            '-i', 'testsrc=duration=2:size=800x600:rate=10',
            '-pix_fmt', 'yuv420p',
            bigFixture,
          ],
          { stdio: 'inherit' },
        );
        if (res.status !== 0) {
          throw new Error(`failed to generate big fixture (status=${res.status})`);
        }
      }

      const frame = await extractPosterFrame({
        contentUrl: `file://${bigFixture}`,
        maxDimension: MAX_DIMENSION,
      });

      expect(frame.data.length).toBeGreaterThan(0);
      expect(frame.width).toBeLessThanOrEqual(MAX_DIMENSION);
      expect(frame.height).toBeLessThanOrEqual(MAX_DIMENSION);
      // At least one dimension should hit the cap for an 800x600 source scaled
      // to inside a 320-box (width caps to 320).
      expect(Math.max(frame.width, frame.height)).toBe(MAX_DIMENSION);
    },
  );

  it('throws FrameExtractionError for an unreachable/nonexistent input', async () => {
    // A file:// URL that does not exist is not retrievable; ffmpeg exits
    // non-zero (or, if ffmpeg is absent, the spawn itself errors). Either way the
    // extractor must surface FrameExtractionError (Requirements 17.1, 17.2).
    const missing = `file://${path.join(FIXTURES_DIR, 'does-not-exist.mp4')}`;
    await expect(
      extractPosterFrame({ contentUrl: missing, maxDimension: MAX_DIMENSION }),
    ).rejects.toBeInstanceOf(FrameExtractionError);
  });

  it('throws FrameExtractionError for undecodable input bytes', async () => {
    // A syntactically valid but non-video path: point at this test file itself.
    // ffmpeg cannot decode a frame from it, so extraction must fail cleanly
    // (Requirement 17.1). When ffmpeg is missing, the spawn error path yields the
    // same FrameExtractionError class.
    const undecodable = `file://${fileURLToPath(import.meta.url)}`;
    await expect(
      extractPosterFrame({ contentUrl: undecodable, maxDimension: MAX_DIMENSION }),
    ).rejects.toBeInstanceOf(FrameExtractionError);
  });

  it('reports whether ffmpeg was available for the live assertions', () => {
    // This is a visibility test: it never fails, but records in the test output
    // whether the ffmpeg-dependent assertions actually ran live.
    if (!HAS_FFMPEG) {
      // eslint-disable-next-line no-console
      console.warn(
        '[frame-extraction.test] ffmpeg UNAVAILABLE: live extraction assertions ' +
          'were skipped; only the error-path assertions executed.',
      );
    }
    expect(typeof HAS_FFMPEG).toBe('boolean');
    // Guard against an unused-import lint in the fixture-size check below.
    if (HAS_FFMPEG && existsSync(FIXTURE_VIDEO)) {
      expect(statSync(FIXTURE_VIDEO).size).toBeGreaterThan(0);
    }
  });
});
