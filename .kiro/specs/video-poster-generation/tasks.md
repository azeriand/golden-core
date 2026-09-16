# Implementation Plan: Video Poster Generation

## Overview

This plan converts the design into incremental, dependency-ordered coding steps.
Foundation first (migration + idempotent enqueue helper), then the two Vercel
enqueue wirings (confirm + webhook), then the Railway worker built bottom-up
(config → db → queue state machine → frame extraction → per-job pipeline → poll
loop), then deploy config, then DTO/API exposure and frontend rendering, and
finally the one-time backfill. New modules match the repo's heavily-commented,
idempotency-first conventions (unique index + `ON CONFLICT`, correlation keys,
server-side-only secrets) and cite the requirement clauses they satisfy.

Property-based tests use fast-check + vitest and live in `tests/` following the
existing `pN-*.property.test.ts` naming; example/unit tests follow the existing
`*.test.ts` convention. Tests are wired into the task where the corresponding
code is implemented (test-first / test-alongside), not deferred to the end.

## Tasks

- [x] 1. Schema foundation: migration 004 (poster_url column + poster_jobs queue)
  - Create `migrations/004_add_poster_url_and_poster_jobs.sql` following the
    numbered convention of `002_add_upload_id_column.sql` / `003_media_section_id_nullable.sql`.
  - `ALTER TABLE public.media ADD COLUMN poster_url text;` (nullable, no default;
    existing rows stay valid with `poster_url = NULL`).
  - `CREATE TABLE public.poster_jobs (id bigserial PK, media_id integer NOT NULL
    REFERENCES public.media(media_id), status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','done','failed')), attempts integer
    NOT NULL DEFAULT 0, run_after/created_at/updated_at timestamptz NOT NULL
    DEFAULT now())`.
  - `CREATE UNIQUE INDEX poster_jobs_media_id_key ON public.poster_jobs (media_id)`
    (the atomic dedupe primitive for `ON CONFLICT (media_id) DO NOTHING`, mirrors
    `media_upload_id_key`) and `CREATE INDEX poster_jobs_claim_idx ON
    public.poster_jobs (status, run_after)`.
  - Add heavily-commented header plus a documented, commented rollback that drops
    the indexes, table, then column in reverse order. Additive/reversible only;
    do not modify any existing media column, constraint, index, or data. Note in
    comments that the live "is video" column is `type` (MIME), not `media_type`.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 5.2, 16.4_

- [x] 2. Idempotent enqueue helper (`lib/poster-jobs.ts`)
  - [x] 2.1 Implement `enqueuePosterJob` and `isVideoType`
    - Create `lib/poster-jobs.ts` following the `lib/section-match.ts` style
      (pure, heavily commented, accepts a `Pool | PoolClient` executor).
    - `enqueuePosterJob(db, mediaId)` runs `INSERT INTO poster_jobs (...) VALUES
      (media_id, 'pending', 0, now(), now(), now()) ON CONFLICT (media_id) DO
      NOTHING`, returning `true` when a new row was inserted, `false` on conflict.
      Never throws for the "already exists" case; surfaces genuine DB errors to
      the caller.
    - `isVideoType(type)` returns `true` iff `type` is a string beginning with
      `video/` — the single source of truth shared by both enqueue paths and the
      backfill.
    - _Requirements: 3.1, 3.2, 3.4, 4.1, 4.3, 5.1, 5.2, 5.3, 13.2_

  - [x] 2.2 Write property test for enqueue idempotency
    - **Property 1: Enqueue idempotency — at most one job per media_id**
    - Model an in-memory `poster_jobs` reference (unique index on `media_id` +
      `ON CONFLICT DO NOTHING`); fast-check generates any sequence/interleaving of
      enqueue calls (both paths) for a media id and asserts exactly one final job.
    - File: `tests/p8-enqueue-idempotency.property.test.ts` (fast-check + vitest, ≥100 runs).
    - **Validates: Requirements 2.4, 4.5, 5.1, 5.2, 5.3, 3.3, 4.2**

  - [x] 2.3 Write property test for video-only enqueue gating
    - **Property 2: Enqueue is video-only**
    - fast-check generates arbitrary `type` strings (`video/*`, `image/*`, `null`,
      junk) and asserts `isVideoType` gates enqueue: a job is created iff video.
    - File: `tests/p9-enqueue-video-only.property.test.ts`.
    - **Validates: Requirements 3.1, 3.2, 4.1, 4.3, 13.2**

  - [x] 2.4 Write unit test for enqueue helper no-op-on-conflict
    - Concrete example (test double / transactional test DB): first call inserts,
      second call for same `media_id` is a no-op returning `false`.
    - File: `tests/poster-jobs.test.ts`.
    - _Requirements: 5.1, 5.2, 5.3_

- [x] 3. Wire enqueue into the Confirm_Route
  - Edit `app/api/event/[event-slug]/media/confirm/route.ts`. After the media row
    is committed/shaped, on BOTH the newly-inserted (201) and already-exists (200)
    branches, call `enqueuePosterJob(pool, row.media_id)` guarded by
    `isVideoType(row.type)` (video-only).
  - Wrap the enqueue in `try/catch`: on error, log non-secret context
    (`media_id`, error message) and still return the successful media response —
    media creation must never be failed by an enqueue error (swallow-and-log).
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 4.5, 5.1, 15.3_

  - [x] 3.1 Write unit tests for confirm-route enqueue wiring
    - Extend/add `tests/confirm.route.test.ts`: video insert enqueues; image
      insert does not; already-exists branch enqueues without duplicating; a
      thrown enqueue error is swallowed and the media response still returns.
    - _Requirements: 3.1, 3.2, 3.3, 3.5_

- [x] 4. Wire enqueue into the Webhook_Path (`onUploadCompleted`)
  - Edit `app/api/event/[event-slug]/media/upload-token/route.ts`. Inside
    `onUploadCompleted`, after the idempotent media INSERT: determine video via
    `isVideoType(blob.contentType)`; resolve `media_id` with `SELECT media_id FROM
    media WHERE upload_id = $1` so enqueue works on both the freshly-inserted and
    no-op branches; call `enqueuePosterJob(pool, media_id)` for videos only.
  - Error semantics differ from confirm: a transient enqueue DB error is
    RETHROWN so Vercel Blob retries the webhook. `ON CONFLICT DO NOTHING` makes
    the retry produce no duplicate job.
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 5.1_

  - [x] 4.1 Write unit tests for webhook-path enqueue wiring
    - Add `tests/upload-token.route.test.ts`: freshly-inserted and no-op branches
      both enqueue exactly one job; image content does not enqueue; a transient
      enqueue error is rethrown (webhook retryable).
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

- [x] 5. Checkpoint - foundation + enqueue paths
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Worker scaffolding: config, db, logger (`worker/`)
  - [x] 6.1 Create worker package scaffold and config loader
    - Create `worker/package.json` (own deps: `pg`, `@vercel/blob`, `sharp`,
      `fast-check`/`vitest` for tests), `worker/tsconfig.json`, and
      `worker/src/config.ts` parsing env: `DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`
      (secrets, env-only), `POSTER_WORKER_CONCURRENCY` (≥1, default 2),
      `POSTER_MAX_ATTEMPTS`, `POSTER_POLL_INTERVAL_MS`,
      `POSTER_STALE_PROCESSING_SECONDS`, `POSTER_MAX_DIMENSION`,
      `POSTER_BACKOFF_BASE_SECONDS`.
    - _Requirements: 6.2, 6.3, 7.3, 7.6, 8.2, 9.6, 10.2, 14.1_

  - [x] 6.2 Implement worker db pool and secret-free logger
    - `worker/src/db.ts`: a `pg` Pool reading `DATABASE_URL` from env only.
    - `worker/src/logger.ts`: structured logging that emits `media_id`, status
      transitions, `attempts`, and short error descriptions only — never
      `DATABASE_URL` or `BLOB_READ_WRITE_TOKEN` values.
    - _Requirements: 6.3, 14.1, 14.2, 14.3, 14.4, 16.1, 16.2, 16.3_

  - [x] 6.3 Write secrets-not-logged unit test
    - Simulate a processing failure and assert captured log output contains
      neither the `DATABASE_URL` nor `BLOB_READ_WRITE_TOKEN` values.
    - File: `worker/tests/logger.secrets.test.ts` (or `tests/worker-logger.secrets.test.ts`).
    - _Requirements: 14.3, 14.4_

- [x] 7. Queue state machine (`worker/src/queue.ts`)
  - [x] 7.1 Implement claim/complete/fail/reclaim SQL
    - `claimJobs(limit)`: single `UPDATE ... SET status='processing', updated_at=now()
      WHERE id IN (SELECT id ... WHERE status='pending' AND run_after<=now() ORDER
      BY run_after FOR UPDATE SKIP LOCKED LIMIT $1) RETURNING ...` — transitions to
      `processing` inside the claim.
    - `completeJob(id)`: set status `done`.
    - `failJob(id, attempts)`: increment `attempts`; if `attempts+1 >= Max_Attempts`
      set `failed` (leave `run_after`), else set `pending` with
      `run_after = now() + base * power(2, attempts)` seconds (exponential backoff).
    - `reclaimStaleProcessing(timeoutSeconds)`: return `processing` jobs whose
      `updated_at` is older than the timeout back to `pending`.
    - _Requirements: 7.1, 7.2, 7.5, 8.5, 9.1, 9.2, 9.3, 9.4, 9.5, 10.2_

  - [x] 7.2 Write property test for SKIP LOCKED exclusive claims
    - **Property 5: SKIP LOCKED gives exclusive claims**
    - In-memory reference model of `poster_jobs`; generate multiple simultaneous
      claim batches over the same due-job set, assert disjoint claims and every
      claimed job transitioned to `processing`.
    - File: `tests/p10-skip-locked-exclusive.property.test.ts`.
    - **Validates: Requirements 7.1, 7.2, 7.5**

  - [x] 7.3 Write property test for retry increment and backoff monotonicity
    - **Property 7: Retry increments attempts and backoff is non-decreasing**
    - Assert a failure while `attempts+1 < Max_Attempts` increments `attempts` by
      exactly one, sets strictly-future `run_after`, and backoff is non-decreasing
      as `attempts` grows.
    - File: `tests/p11-retry-backoff.property.test.ts`.
    - **Validates: Requirements 9.1, 9.2, 9.3**

  - [x] 7.4 Write property test for Max_Attempts termination and no reclaim of failed
    - **Property 8: Max_Attempts terminates retries and failed jobs are never reclaimed**
    - Assert failure at `attempts+1 >= Max_Attempts` yields `failed`, and no claim
      cycle ever selects a `failed` job.
    - File: `tests/p12-max-attempts-terminal.property.test.ts`.
    - **Validates: Requirements 9.4, 9.5**

  - [x] 7.5 Write property test for stale-processing reclaim
    - **Property 10: Stale-processing jobs become reclaimable**
    - Assert `processing` jobs older than the stale timeout are returned to
      `pending` by reclaim; jobs within the timeout are not reclaimed.
    - File: `tests/p13-stale-reclaim.property.test.ts`.
    - **Validates: Requirements 10.2, 10.3**

  - [x] 7.6 Write unit test for failJob backoff ordering
    - Concrete attempts values produce expected `run_after` ordering and the
      `failed` transition exactly at `Max_Attempts`.
    - File: `tests/failjob-backoff.test.ts`.
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

- [x] 8. Frame extraction (`worker/src/frame.ts`)
  - [x] 8.1 Implement ffmpeg early-frame extraction + downscale
    - Invoke the `ffmpeg` binary reading from the video `content` URL, seeking an
      early timestamp, emitting one frame (`-frames:v 1`), downscaled to at most
      `POSTER_MAX_DIMENSION` via the `scale` filter; finalize the small
      JPEG/WebP encode (optionally piping through `sharp`).
    - Treat "content not retrievable" and "cannot decode a frame" as normal
      failure paths (throw); attempt a bounded fallback (seek `0`) before failing.
    - _Requirements: 8.1, 8.2, 17.1, 17.2_

  - [x] 8.2 Write unit test for frame extraction with a fixture video
    - Use a small fixture video under `tests/fixtures/`; assert a non-empty,
      correctly-downscaled image (dimension ≤ `POSTER_MAX_DIMENSION`) is produced;
      assert unreachable/undecodable input throws.
    - File: `tests/frame-extraction.test.ts`.
    - _Requirements: 8.1, 8.2, 17.1, 17.2_

- [x] 9. Per-job pipeline (`worker/src/process-job.ts`)
  - [x] 9.1 Implement the content→ffmpeg→blob→db pipeline
    - Load media row (`content`, `type`, `poster_url`) for the job's `media_id`.
    - Processing idempotency: if `poster_url` already non-null, `completeJob` and
      skip generation.
    - Extract frame (`frame.ts`), upload poster to Vercel Blob under
      `posters/{media_id}/poster.<ext>` using `BLOB_READ_WRITE_TOKEN` from env,
      then `UPDATE media SET poster_url = $1 WHERE media_id = $2` (single final
      URL, only after successful upload), then `completeJob(id)`.
    - Any thrown error routes to `failJob`; on failure leave `poster_url`
      unchanged. Log claim/done/failure with non-secret context.
    - _Requirements: 8.3, 8.4, 8.5, 8.6, 10.1, 10.3, 10.4, 16.1, 16.2, 16.3, 17.3_

  - [x] 9.2 Write property test for done ⇒ non-null poster_url
    - **Property 3: A done job implies a non-null poster_url**
    - Reference-model worker ops over random job sets (Blob/ffmpeg mocked); assert
      every `done` job's media row has non-null `poster_url`.
    - File: `tests/p14-done-implies-poster.property.test.ts`.
    - **Validates: Requirements 8.4, 8.5, 10.1, 10.4**

  - [x] 9.3 Write property test for failure never overwrites poster_url
    - **Property 4: Failure never overwrites poster_url**
    - Inject failures (ffmpeg-cannot-decode, content-not-retrievable); assert the
      media row's `poster_url` is exactly its pre-attempt value (never cleared /
      partial).
    - File: `tests/p15-failure-preserves-poster.property.test.ts`.
    - **Validates: Requirements 8.4, 10.4, 17.1, 17.2, 17.3**

  - [x] 9.4 Write property test for processing idempotency (re-run safety)
    - **Property 9: Processing idempotency (re-run safety)**
    - For a media row already having non-null `poster_url`, processing transitions
      to `done` without a new image and without changing `poster_url`.
    - File: `tests/p16-processing-idempotency.property.test.ts`.
    - **Validates: Requirements 10.1, 10.3, 10.4**

  - [x] 9.5 Write property test for poster blob path namespacing
    - **Property 11: Poster blob path is namespaced by media_id**
    - Generate arbitrary `media_id`s; assert the computed upload path is under
      `posters/{media_id}/`.
    - File: `tests/p17-poster-path-namespace.property.test.ts`.
    - **Validates: Requirements 8.3, 8.6**

- [x] 10. Poll loop + graceful shutdown (`worker/src/index.ts`)
  - [x] 10.1 Implement the poll cycle, bounded concurrency, and shutdown
    - Factor a single "tick" (`reclaimStaleProcessing → compute free capacity
      (N - inFlight) → claimJobs(freeCapacity) → dispatch to process-job`) callable
      in isolation for deterministic tests.
    - Entry point: log a secret-free startup line, run ticks on
      `POSTER_POLL_INTERVAL_MS`, track in-flight count so simultaneous processing
      never exceeds `N`, and never claim while `inFlight == N`.
    - Graceful shutdown (SIGTERM/SIGINT): stop claiming, wait for in-flight jobs
      to finish so no job is abandoned mid-write.
    - _Requirements: 6.4, 7.3, 7.4, 10.2, 16.1_

  - [x] 10.2 Write property test for bounded concurrency
    - **Property 6: Bounded concurrency is respected**
    - For any `N >= 1` and any arrival pattern, driving ticks never leaves more
      than `N` jobs simultaneously in `processing` for one worker.
    - File: `tests/p18-bounded-concurrency.property.test.ts`.
    - **Validates: Requirements 7.3, 7.4, 7.6**

  - [x] 10.3 Write property test for one failing job not blocking others
    - **Property 13: One failing job does not block others**
    - For a claimed batch where an arbitrary subset fails, every non-failing job
      is still processed to completion in the same run.
    - File: `tests/p19-failure-isolation.property.test.ts`.
    - **Validates: Requirements 17.4**

- [x] 11. Deployment config: Dockerfile + railway.json (ffmpeg at runtime)
  - Create `worker/Dockerfile` on a Node base image installing `ffmpeg` at build
    time (Debian `apt-get install -y ffmpeg` or nixpacks ffmpeg), building the
    worker and setting start `node dist/index.js`.
  - Create `worker/railway.json` pinning the Dockerfile builder, the start
    command, and an always-restart policy so the long-running worker is
    supervised. (Config files only — no deploy execution.)
  - _Requirements: 6.1, 6.2, 6.5_

- [x] 12. Checkpoint - worker complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 13. Media DTO + Event endpoint + Confirm response poster_url exposure
  - [x] 13.1 Add poster_url to the Media DTO
    - `app/dto/media.ts`: add `poster_url: string | null` to the `Media` interface.
    - _Requirements: 11.1_

  - [x] 13.2 Expose poster_url from the event endpoint and confirm response
    - `app/api/event/[event-slug]/route.ts`: add `media.poster_url` to the GET
      SELECT column list and map it into each `Media` item (`NULL` → `null`).
    - `app/api/event/[event-slug]/media/confirm/route.ts`: `shapeMediaRow` returns
      `poster_url: row.poster_url ?? null` so newly created video responses match
      the DTO shape.
    - _Requirements: 11.2, 11.3, 11.4, 15.4_

  - [x] 13.3 Write property test for faithful DTO poster_url mapping
    - **Property 12: DTO exposes poster_url faithfully**
    - Generate media rows with `poster_url` string-or-null; assert the DTO
      mapping (event endpoint + confirm shape) preserves value and `null` exactly
      when stored value is `NULL`.
    - File: `tests/p20-dto-poster-url.property.test.ts`.
    - **Validates: Requirements 11.1, 11.2, 11.3, 11.4, 15.4**

- [x] 14. Frontend gallery poster rendering (`app/components/media-item.tsx`)
  - Thread an optional `poster_url` prop from `masonry.tsx` (sourced from
    `Media.poster_url`) into the video branch of `media-item.tsx`.
  - When `poster_url` present: render `<video poster={poster_url} preload="none" ...>`.
  - When `null`: reserve layout space and show the placeholder + existing
    play-button overlay; rendering stays synchronous (no blocking on poster).
  - On poster `onError` or a configured `setTimeout` guard (cleared on successful
    poster load), fall back to the placeholder so every slot shows a visible
    element. Videos without a poster still play when opened.
  - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 15.1, 15.2_

  - [x] 14.1 Write interaction tests for media-item poster rendering
    - Renders `<video poster preload="none">` when `poster_url` present; renders
      placeholder + play overlay when `null`; falls back to placeholder on
      `onError`/timeout.
    - File: `tests/media-item.test.tsx`.
    - _Requirements: 12.1, 12.2, 12.3, 12.5_

- [x] 15. One-time backfill command (`worker/src/backfill.ts`)
  - Implement a single set-based idempotent insert:
    `INSERT INTO poster_jobs (media_id, status, attempts, run_after, created_at,
    updated_at) SELECT m.media_id, 'pending', 0, now(), now(), now() FROM media m
    WHERE m.type LIKE 'video/%' AND m.poster_url IS NULL ON CONFLICT (media_id) DO
    NOTHING;` runnable via `node worker/dist/backfill.js`.
  - Video-only, only rows with `NULL` poster_url, no duplicate jobs on rerun,
    never touches `media`/`content`. Heavily commented, idempotency-first.
  - _Requirements: 13.1, 13.2, 13.3, 13.4_

  - [x] 15.1 Write unit test for backfill idempotency
    - Assert backfill enqueues only video rows with `NULL` poster_url, skips
      images and rows with existing jobs, and reruns create no duplicates.
    - File: `tests/backfill.test.ts`.
    - _Requirements: 13.1, 13.2, 13.3, 13.4_

- [x] 16. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a
  faster MVP; core implementation tasks are never optional.
- Each task references specific requirements for traceability, and each property
  sub-task cites its Property number and the requirement clauses it validates.
- Property-based tests use fast-check + vitest at ≥100 iterations and follow the
  repo's `tests/pN-*.property.test.ts` convention; the queue state machine is
  exercised against an in-memory reference model with ffmpeg/Blob mocked.
- Deployment tasks cover writing the `Dockerfile` and `railway.json` config only;
  actual deployment, user testing, and metrics gathering are out of scope.
- New modules follow the codebase's heavily-commented, idempotency-first
  conventions (unique index + `ON CONFLICT (media_id) DO NOTHING`, correlation
  keys, and env-only server-side secrets).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1", "6.1"] },
    { "id": 1, "tasks": ["2.1", "6.2", "8.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4", "6.3", "7.1", "8.2", "13.1"] },
    { "id": 3, "tasks": ["3", "4", "7.2", "7.3", "7.4", "7.5", "7.6", "9.1", "13.2"] },
    { "id": 4, "tasks": ["3.1", "4.1", "9.2", "9.3", "9.4", "9.5", "10.1", "13.3", "14", "15"] },
    { "id": 5, "tasks": ["10.2", "10.3", "11", "14.1", "15.1"] }
  ]
}
```
