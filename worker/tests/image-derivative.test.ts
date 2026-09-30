// Unit tests for the image display-derivative pipeline (Task 5.4).
//
// Exercises runImageDerivativeJob's control flow over injected boundaries
// (fetchOriginal / encodeDerivative / uploadDerivative / db / completeJob) so no
// network, sharp, or Postgres is touched:
//
//   - SUCCESS: a smaller derivative is uploaded and media.content is rewritten to
//     the derivative URL; original_url is NEVER touched (Req 3.2, 3.3, P5).
//   - NEVER-ENLARGE: when the derivative is not smaller than the original, the
//     original stays the served content (no upload, no content UPDATE) and the
//     job still completes (Req 3.5).
//   - IDEMPOTENT RE-RUN: when content already points at the derivative namespace,
//     the job completes without fetching/encoding/uploading again (Req 3.6, P4).
//   - ATOMIC WRITE (P3): if encode or upload throws, the error PROPAGATES and no
//     content UPDATE runs — the original is preserved (Req 8.4, 17.3).
//   - ORIGINAL FALLBACK: original_url is preferred as the fetch source; a legacy
//     row (original_url NULL) falls back to content.

import { describe, expect, it, vi } from 'vitest';
import type { WorkerConfig } from '../src/config.js';
import {
  runImageDerivativeJob,
  imageDerivativePath,
  isDerivativeUrl,
  type EncodedImage,
  type ImageDerivativeDeps,
} from '../src/image-derivative.js';
import type { MediaJob } from '../src/queue.js';

// --- Fixtures ---------------------------------------------------------------

const CONFIG: WorkerConfig = {
  databaseUrl: 'postgres://ignored',
  blobReadWriteToken: 'blob-token-ignored',
  concurrency: 2,
  maxAttempts: 5,
  pollIntervalMs: 2000,
  staleProcessingSeconds: 300,
  maxDimension: 640,
  backoffBaseSeconds: 5,
  imageMaxDimension: 2000,
  imageQuality: 80,
  videoMaxHeight: 1080,
  videoCrf: 23,
  videoPreset: 'veryfast',
};

function imageJob(mediaId: number): MediaJob {
  return {
    id: mediaId * 10,
    media_id: mediaId,
    kind: 'image',
    status: 'processing',
    attempts: 0,
    run_after: new Date().toISOString(),
  };
}

/**
 * An in-memory media-row store that records every UPDATE so tests can assert
 * exactly what (if anything) was written to `content`. Only the two statements
 * the pipeline issues are recognized: the SELECT of the row, and the content
 * UPDATE.
 */
function createDb(row: {
  content: string;
  original_url: string | null;
  type: string | null;
}) {
  const state = { ...row };
  const contentUpdates: string[] = [];

  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (/^SELECT .* FROM media WHERE media_id/i.test(sql)) {
      return { rows: [{ ...state }], rowCount: 1 };
    }
    if (/^UPDATE media SET content/i.test(sql)) {
      const url = (params ?? [])[0] as string;
      state.content = url;
      contentUpdates.push(url);
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected SQL in image-derivative test: ${sql}`);
  });

  return {
    query: query as unknown as ImageDerivativeDeps['db']['query'],
    contentUpdates: () => contentUpdates,
    currentContent: () => state.content,
    currentOriginal: () => state.original_url,
  };
}

function encoded(bytes: number): EncodedImage {
  return {
    data: Buffer.alloc(bytes, 1),
    contentType: 'image/webp',
    extension: 'webp',
    width: 1000,
    height: 1000,
  };
}

// --- Tests ------------------------------------------------------------------

describe('runImageDerivativeJob', () => {
  it('uploads a smaller derivative, rewrites content, and never touches original_url', async () => {
    const db = createDb({
      content: 'https://blob.example/events/1/orig.jpg',
      original_url: 'https://blob.example/events/1/orig.jpg',
      type: 'image/jpeg',
    });
    const completeJob = vi.fn(async () => {});
    const uploadedUrl = 'https://blob.example/derivatives/7/image.webp';

    const deps: ImageDerivativeDeps = {
      config: CONFIG,
      db,
      completeJob,
      // 5 MB original -> 500 KB derivative (smaller -> should be adopted).
      fetchOriginal: vi.fn(async () => Buffer.alloc(5_000_000, 9)),
      encodeDerivative: vi.fn(async () => encoded(500_000)),
      uploadDerivative: vi.fn(async () => ({ url: uploadedUrl })),
    };

    await runImageDerivativeJob(imageJob(7), deps);

    // content rewritten to exactly the uploaded derivative URL.
    expect(db.contentUpdates()).toEqual([uploadedUrl]);
    expect(db.currentContent()).toBe(uploadedUrl);
    // original_url untouched (P5).
    expect(db.currentOriginal()).toBe('https://blob.example/events/1/orig.jpg');
    // Uploaded under the media_id-namespaced derivative path.
    expect((deps.uploadDerivative as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      imageDerivativePath(7, 'webp'),
    );
    expect(completeJob).toHaveBeenCalledTimes(1);
  });

  it('keeps the original (no upload, no content UPDATE) when the derivative is not smaller', async () => {
    const db = createDb({
      content: 'https://blob.example/events/1/small.jpg',
      original_url: 'https://blob.example/events/1/small.jpg',
      type: 'image/jpeg',
    });
    const completeJob = vi.fn(async () => {});
    const uploadDerivative = vi.fn(async () => ({ url: 'should-not-upload' }));

    const deps: ImageDerivativeDeps = {
      config: CONFIG,
      db,
      completeJob,
      // 100 KB original -> 120 KB "derivative" (bigger -> must be discarded).
      fetchOriginal: vi.fn(async () => Buffer.alloc(100_000, 9)),
      encodeDerivative: vi.fn(async () => encoded(120_000)),
      uploadDerivative,
    };

    await runImageDerivativeJob(imageJob(8), deps);

    expect(uploadDerivative).not.toHaveBeenCalled();
    expect(db.contentUpdates()).toEqual([]);
    expect(db.currentContent()).toBe('https://blob.example/events/1/small.jpg');
    expect(completeJob).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: content already a derivative -> complete without re-processing', async () => {
    const derivativeUrl = 'https://blob.example/derivatives/9/image.webp';
    expect(isDerivativeUrl(derivativeUrl)).toBe(true);

    const db = createDb({
      content: derivativeUrl,
      original_url: 'https://blob.example/events/1/orig.jpg',
      type: 'image/jpeg',
    });
    const completeJob = vi.fn(async () => {});
    const fetchOriginal = vi.fn(async () => Buffer.alloc(1, 0));
    const encodeDerivative = vi.fn(async () => encoded(1));
    const uploadDerivative = vi.fn(async () => ({ url: 'x' }));

    await runImageDerivativeJob(imageJob(9), {
      config: CONFIG,
      db,
      completeJob,
      fetchOriginal,
      encodeDerivative,
      uploadDerivative,
    });

    // No work done beyond the completeJob transition.
    expect(fetchOriginal).not.toHaveBeenCalled();
    expect(encodeDerivative).not.toHaveBeenCalled();
    expect(uploadDerivative).not.toHaveBeenCalled();
    expect(db.contentUpdates()).toEqual([]);
    expect(completeJob).toHaveBeenCalledTimes(1);
  });

  it('propagates an encode error and leaves content unchanged (atomic write P3)', async () => {
    const db = createDb({
      content: 'https://blob.example/events/1/orig.jpg',
      original_url: 'https://blob.example/events/1/orig.jpg',
      type: 'image/jpeg',
    });
    const completeJob = vi.fn(async () => {});

    const deps: ImageDerivativeDeps = {
      config: CONFIG,
      db,
      completeJob,
      fetchOriginal: vi.fn(async () => Buffer.alloc(5_000_000, 9)),
      encodeDerivative: vi.fn(async () => {
        throw new Error('sharp: unsupported input');
      }),
      uploadDerivative: vi.fn(async () => ({ url: 'x' })),
    };

    await expect(runImageDerivativeJob(imageJob(10), deps)).rejects.toThrow(
      'sharp: unsupported input',
    );
    // No content rewrite, no completeJob — the wrapper handles failJob.
    expect(db.contentUpdates()).toEqual([]);
    expect(db.currentContent()).toBe('https://blob.example/events/1/orig.jpg');
    expect(completeJob).not.toHaveBeenCalled();
  });

  it('propagates an upload error and leaves content unchanged (atomic write P3)', async () => {
    const db = createDb({
      content: 'https://blob.example/events/1/orig.jpg',
      original_url: 'https://blob.example/events/1/orig.jpg',
      type: 'image/jpeg',
    });
    const completeJob = vi.fn(async () => {});

    const deps: ImageDerivativeDeps = {
      config: CONFIG,
      db,
      completeJob,
      fetchOriginal: vi.fn(async () => Buffer.alloc(5_000_000, 9)),
      encodeDerivative: vi.fn(async () => encoded(500_000)),
      uploadDerivative: vi.fn(async () => {
        throw new Error('blob: upload failed');
      }),
    };

    await expect(runImageDerivativeJob(imageJob(11), deps)).rejects.toThrow(
      'blob: upload failed',
    );
    expect(db.contentUpdates()).toEqual([]);
    expect(completeJob).not.toHaveBeenCalled();
  });

  it('prefers original_url as the fetch source, falling back to content on a legacy row', async () => {
    // Row WITH original_url: it is fetched.
    const withOriginal = createDb({
      content: 'https://blob.example/derivatives-not/1/served.jpg',
      original_url: 'https://blob.example/events/1/ORIGINAL.jpg',
      type: 'image/jpeg',
    });
    const fetchWith = vi.fn(async () => Buffer.alloc(5_000_000, 9));
    await runImageDerivativeJob(imageJob(12), {
      config: CONFIG,
      db: withOriginal,
      completeJob: vi.fn(async () => {}),
      fetchOriginal: fetchWith,
      encodeDerivative: vi.fn(async () => encoded(500_000)),
      uploadDerivative: vi.fn(async () => ({ url: 'https://blob.example/derivatives/12/image.webp' })),
    });
    expect(fetchWith.mock.calls[0][0]).toBe('https://blob.example/events/1/ORIGINAL.jpg');

    // Legacy row (original_url NULL): content is fetched instead.
    const legacy = createDb({
      content: 'https://blob.example/events/1/legacy.jpg',
      original_url: null,
      type: 'image/jpeg',
    });
    const fetchLegacy = vi.fn(async () => Buffer.alloc(5_000_000, 9));
    await runImageDerivativeJob(imageJob(13), {
      config: CONFIG,
      db: legacy,
      completeJob: vi.fn(async () => {}),
      fetchOriginal: fetchLegacy,
      encodeDerivative: vi.fn(async () => encoded(500_000)),
      uploadDerivative: vi.fn(async () => ({ url: 'https://blob.example/derivatives/13/image.webp' })),
    });
    expect(fetchLegacy.mock.calls[0][0]).toBe('https://blob.example/events/1/legacy.jpg');
  });
});
