// Unit tests for the video-transcode pipeline (Task 6.5).
//
// Exercises runVideoTranscodeJob's control flow over injected boundaries
// (transcode / uploadTranscode / db / completeJob) so no network, ffmpeg, or
// Postgres is touched:
//
//   - SUCCESS: a transcode is uploaded and media.content is rewritten to the
//     derivative URL; original_url is NEVER touched (Req 4.2, 4.3, P5).
//   - IDEMPOTENT RE-RUN: when content already points at the derivative namespace,
//     the job completes without transcoding/uploading again (Req 4.6, P4).
//   - FAILURE -> FALLBACK (P3): if transcode or upload throws, the error
//     PROPAGATES and no content UPDATE runs, so the app keeps serving the
//     original (Req 4.5, 8.4, 17.3).
//   - ORIGINAL SOURCE: original_url is preferred as the transcode source; a
//     legacy row (original_url NULL) falls back to content.

import { describe, expect, it, vi } from 'vitest';
import type { WorkerConfig } from '../src/config.js';
import {
  runVideoTranscodeJob,
  videoTranscodePath,
  type EncodedVideo,
  type VideoTranscodeDeps,
} from '../src/video-transcode.js';
import { isDerivativeUrl } from '../src/image-derivative.js';
import type { MediaJob } from '../src/queue.js';

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

function videoJob(mediaId: number): MediaJob {
  return {
    id: mediaId * 10,
    media_id: mediaId,
    kind: 'video',
    status: 'processing',
    attempts: 0,
    run_after: new Date().toISOString(),
  };
}

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
    throw new Error(`unexpected SQL in video-transcode test: ${sql}`);
  });

  return {
    query: query as unknown as VideoTranscodeDeps['db']['query'],
    contentUpdates: () => contentUpdates,
    currentContent: () => state.content,
    currentOriginal: () => state.original_url,
  };
}

const MP4: EncodedVideo = {
  data: Buffer.alloc(1000, 1),
  contentType: 'video/mp4',
  extension: 'mp4',
};

describe('runVideoTranscodeJob', () => {
  it('uploads a transcode, rewrites content, and never touches original_url', async () => {
    const db = createDb({
      content: 'https://blob.example/events/1/orig.mov',
      original_url: 'https://blob.example/events/1/orig.mov',
      type: 'video/quicktime',
    });
    const completeJob = vi.fn(async () => {});
    const uploadedUrl = 'https://blob.example/derivatives/3/video.mp4';
    const transcode = vi.fn(async () => MP4);
    const uploadTranscode = vi.fn(async () => ({ url: uploadedUrl }));

    await runVideoTranscodeJob(videoJob(3), {
      config: CONFIG,
      db,
      completeJob,
      transcode,
      uploadTranscode,
    });

    expect(transcode.mock.calls[0][0]).toBe('https://blob.example/events/1/orig.mov');
    expect(uploadTranscode.mock.calls[0][0]).toBe(videoTranscodePath(3));
    expect(db.contentUpdates()).toEqual([uploadedUrl]);
    expect(db.currentContent()).toBe(uploadedUrl);
    // original_url untouched (P5).
    expect(db.currentOriginal()).toBe('https://blob.example/events/1/orig.mov');
    expect(completeJob).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: content already a derivative -> complete without re-transcoding', async () => {
    const derivativeUrl = 'https://blob.example/derivatives/4/video.mp4';
    expect(isDerivativeUrl(derivativeUrl)).toBe(true);

    const db = createDb({
      content: derivativeUrl,
      original_url: 'https://blob.example/events/1/orig.mov',
      type: 'video/mp4',
    });
    const completeJob = vi.fn(async () => {});
    const transcode = vi.fn(async () => MP4);
    const uploadTranscode = vi.fn(async () => ({ url: 'x' }));

    await runVideoTranscodeJob(videoJob(4), {
      config: CONFIG,
      db,
      completeJob,
      transcode,
      uploadTranscode,
    });

    expect(transcode).not.toHaveBeenCalled();
    expect(uploadTranscode).not.toHaveBeenCalled();
    expect(db.contentUpdates()).toEqual([]);
    expect(completeJob).toHaveBeenCalledTimes(1);
  });

  it('propagates a transcode failure and leaves content unchanged (fallback to original)', async () => {
    const db = createDb({
      content: 'https://blob.example/events/1/orig.mov',
      original_url: 'https://blob.example/events/1/orig.mov',
      type: 'video/quicktime',
    });
    const completeJob = vi.fn(async () => {});

    await expect(
      runVideoTranscodeJob(videoJob(5), {
        config: CONFIG,
        db,
        completeJob,
        transcode: vi.fn(async () => {
          throw new Error('ffmpeg exited with code 1');
        }),
        uploadTranscode: vi.fn(async () => ({ url: 'x' })),
      }),
    ).rejects.toThrow('ffmpeg exited with code 1');

    // No content rewrite, no completeJob — the original stays served.
    expect(db.contentUpdates()).toEqual([]);
    expect(db.currentContent()).toBe('https://blob.example/events/1/orig.mov');
    expect(completeJob).not.toHaveBeenCalled();
  });

  it('propagates an upload failure and leaves content unchanged', async () => {
    const db = createDb({
      content: 'https://blob.example/events/1/orig.mov',
      original_url: 'https://blob.example/events/1/orig.mov',
      type: 'video/quicktime',
    });
    const completeJob = vi.fn(async () => {});

    await expect(
      runVideoTranscodeJob(videoJob(6), {
        config: CONFIG,
        db,
        completeJob,
        transcode: vi.fn(async () => MP4),
        uploadTranscode: vi.fn(async () => {
          throw new Error('blob: upload failed');
        }),
      }),
    ).rejects.toThrow('blob: upload failed');
    expect(db.contentUpdates()).toEqual([]);
    expect(completeJob).not.toHaveBeenCalled();
  });

  it('falls back to content as the transcode source on a legacy row (original_url NULL)', async () => {
    const legacy = createDb({
      content: 'https://blob.example/events/1/legacy.mp4',
      original_url: null,
      type: 'video/mp4',
    });
    const transcode = vi.fn(async () => MP4);
    await runVideoTranscodeJob(videoJob(14), {
      config: CONFIG,
      db: legacy,
      completeJob: vi.fn(async () => {}),
      transcode,
      uploadTranscode: vi.fn(async () => ({ url: 'https://blob.example/derivatives/14/video.mp4' })),
    });
    expect(transcode.mock.calls[0][0]).toBe('https://blob.example/events/1/legacy.mp4');
  });
});
