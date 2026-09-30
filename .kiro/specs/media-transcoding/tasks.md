# Implementation Plan: Media Transcoding & Original Preservation

- [x] 1. Migration `006_media_jobs_and_original_url.sql`
  - Add `media.original_url text` (nullable, additive, reversible).
  - Generalize the job queue to support `kind` (`poster`|`image`|`video`): create/rename to `media_jobs` with unique index on `(media_id, kind)` and claim index on `(status, run_after)`; migrate existing `poster_jobs` rows as `kind='poster'`.
  - Document forward + rollback SQL; note the stale-`schema.sql` caveat (target the LIVE table).
  - _Requirements: 1.5, 5.1, 5.5, 8.5, 9.3, 9.4_

- [x] 2. Generalize enqueue helper `lib/media-jobs.ts`
  - [x] 2.1 Implement `enqueueMediaJob(db, mediaId, kind)` with `ON CONFLICT (media_id, kind) DO NOTHING`; add `isVideoType`/`isImageType`.
  - [x] 2.2 Keep `lib/poster-jobs.ts` working (shim/re-export or update callers) so nothing breaks.
  - [x] 2.3 Property tests: exactly one job per `(media_id, kind)` (P1); kinds independent (P2).
  - _Requirements: 5.1, 5.2, 5.3, 5.4_

- [ ] 3. Confirm route + webhook: persist original, enqueue by kind
  - [-] 3.1 Add `original_url` to the INSERT (set to the uploaded original's Blob URL; `content` also = original at creation).
  - [~] 3.2 Enqueue `image` for images; `poster` + `video` for videos. Confirm swallows-and-logs enqueue errors; webhook rethrows (unchanged policy).
  - [~] 3.3 Preserve auth, demo guard, blob-namespace verification, orphan cleanup, idempotency.
  - [~] 3.4 Route tests for both paths (create, idempotent repeat, correct kinds).
  - _Requirements: 1.2, 3.1, 4.1, 8.1, 8.2_

- [ ] 4. Worker: kind-aware dispatch (refactor, no behavior change to poster)
  - [~] 4.1 Extract existing poster logic into `processPosterJob`; add a `switch (job.kind)` dispatcher in `process-job.ts`; thread `kind` through `queue.ts` claim/types.
  - [~] 4.2 Keep shared machinery (claim, complete, fail/backoff, reclaim, bounded concurrency, logging) untouched; keep injectable deps.
  - [~] 4.3 Ensure existing poster tests pass unchanged.
  - _Requirements: 5.3, 5.4, 8.3, 8.4_

- [ ] 5. Worker: image display derivative (`worker/src/image-derivative.ts`)
  - [~] 5.1 Fetch original, `sharp` resize to `IMAGE_MAX_DIMENSION` (fit inside, no enlargement), re-encode at `IMAGE_QUALITY`; upload `derivatives/{media_id}/image.<ext>`.
  - [~] 5.2 `UPDATE media SET content = <derivative>` only after successful upload; if not smaller than original, keep original as `content` and still complete.
  - [~] 5.3 Idempotent re-run when `content` already in the derivative namespace (P4).
  - [~] 5.4 Unit/property tests (sizing, never-enlarge, atomic write P3, idempotency P4).
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 8.4_

- [ ] 6. Worker: video transcode (`worker/src/video-transcode.ts`)
  - [~] 6.1 ffmpeg transcode original → H.264/AAC MP4 capped at `VIDEO_MAX_HEIGHT` with `VIDEO_CRF`/`VIDEO_PRESET`; upload `derivatives/{media_id}/video.mp4`.
  - [~] 6.2 `UPDATE media SET content = <derivative>` only after successful upload; on permanent failure leave `content` = original (fallback).
  - [~] 6.3 Idempotent re-run when `content` already in the derivative namespace (P4); failures never crash the loop.
  - [~] 6.4 Add worker config (`IMAGE_MAX_DIMENSION`, `IMAGE_QUALITY`, `VIDEO_MAX_HEIGHT`, `VIDEO_CRF`/`VIDEO_BITRATE`, `VIDEO_PRESET`) with defaults in `config.ts`.
  - [~] 6.5 Unit/integration tests (success, failure→fallback, idempotency, secret-free logging).
  - _Requirements: 4.1, 4.2, 4.3, 4.5, 4.6, 8.3, 8.4_

- [ ] 7. Upload client: stop compressing, upload originals
  - [~] 7.1 Upload the original `File` bytes; keep BlurHash + width/height measurement without substituting uploaded bytes.
  - [~] 7.2 Preserve concurrency cap, retries, IndexedDB resume, `upload_id` idempotency.
  - [~] 7.3 Update/trim `lib/image-preprocess.ts` to "measure + blurhash only" (or bypass its processed blob in the wrapper).
  - _Requirements: 2.1, 2.2, 2.3, 2.4_

- [ ] 8. DTO + Event GET expose `original_url`
  - [~] 8.1 Add `original_url: string | null` to `app/dto/media.ts`.
  - [~] 8.2 Add `media.original_url` to the event GET SELECT and DTO mapping.
  - _Requirements: 6.1, 6.3_

- [ ] 9. Frontend serve-content + fallback (verify, minimal change)
  - [~] 9.1 Confirm images render `content` (original until derivative, then derivative) through existing `next/image`/blurhash path — no URL branching needed.
  - [~] 9.2 Confirm video poster fallback + `preload="none"` playback of `content` unchanged.
  - [~] 9.3 Point the download route (and future WeTransfer hook) to prefer `original_url` when present, else `content`.
  - _Requirements: 6.2, 6.3, 6.4, 6.5_

- [ ] 10. Raise size cap guardrail
  - [~] 10.1 Raise `MAX_FILE_SIZE` to the guardrail (2 GB) in client, upload-token `maximumSizeInBytes`, and confirm; keep in sync.
  - [~] 10.2 Surface a clear over-limit message client-side; keep content-type validation intact.
  - _Requirements: 7.1, 7.2, 7.3, 7.4_

- [ ] 11. Backward compatibility + optional backfill
  - [~] 11.1 Verify legacy rows (`original_url IS NULL`) render by serving existing `content` (P6).
  - [~] 11.2 Extend/add idempotent backfill to enqueue `image`/`video` jobs for existing media without duplicating jobs; poster backfill unaffected.
  - _Requirements: 9.1, 9.2, 9.3, 9.4_

- [ ] 12. Verification
  - [~] 12.1 Run app build/lint/tests and worker build/tests; fix failures.
  - [~] 12.2 Confirm migration applies and rolls back cleanly on a scratch DB (or documents the manual step if no DB available).
  - _Requirements: 8.5_

- [~] 13. Cost re-estimation (owner-requested)
  - Re-estimate storage (originals + derivatives + posters), egress (derivative playback vs. original), Vercel/Blob/Neon/Railway costs (incl. added transcode CPU on Railway), and compare to the pre-change estimate for the 150-guest wedding scenario.
  - _Requirements: n/a (analysis deliverable)_

- [~] 14. Open PR
  - Push `feat/media-transcoding` and open a PR against `main` with a summary, what was tested, and rollout notes.
