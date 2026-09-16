# Design Document: Video Poster Generation

## Overview

This feature adds asynchronous, server-side generation of poster (thumbnail)
images for uploaded videos. Today the gallery renders a bare `<video>` with
`preload="metadata"`; desktop browsers paint a first-frame preview, but iOS
Safari paints nothing, leaving an empty slot. Because uploads go
direct-to-Blob from the browser, the Vercel serverless request path never holds
the video bytes, so poster generation cannot run inside the request path.

The solution follows the codebase's established idempotency-first conventions
(correlation keys, unique indexes, `ON CONFLICT`) and introduces:

1. A nullable `poster_url` column on `public.media` and a new
   `public.poster_jobs` table that acts as a durable job queue inside the
   existing Neon Postgres database — no new managed queue product
   (Requirements 1, 2).
2. A shared, idempotent enqueue helper (`lib/poster-jobs.ts`) wired into BOTH
   video-row creation paths — the `Confirm_Route` and the `Webhook_Path` —
   where a failed enqueue never fails media creation (Requirements 3, 4, 5).
3. A separate, long-running `Poster_Worker` service deployed to Railway that
   polls the queue with `SELECT ... FOR UPDATE SKIP LOCKED`, extracts an early
   frame with ffmpeg, downscales it, uploads the poster to Vercel Blob, and
   records `poster_url` on the media row — with bounded concurrency, retry and
   backoff, stale-processing reclaim, and structured logging
   (Requirements 6, 7, 8, 9, 10, 16, 17).
4. DTO/API exposure of `poster_url` (Requirement 11), a device-consistent
   frontend placeholder/poster render path (Requirement 12), a one-time
   idempotent backfill (Requirement 13), and strict server-side secret handling
   (Requirement 14). Existing media, images, and the upload flow stay unchanged
   (Requirement 15).

### Key existing conventions this design reuses

- **Correlation-key idempotency**: The confirm and webhook routes already dedupe
  media creation through the partial unique index `media_upload_id_key` and
  `ON CONFLICT (upload_id) DO NOTHING`. Poster enqueue mirrors this exactly with
  a unique index on `poster_jobs.media_id` and `ON CONFLICT (media_id) DO NOTHING`.
- **Blob namespacing**: Uploaded bytes live under `events/{eventId}/{uploadId}/...`.
  Posters get their own deterministic namespace derived from `media_id`
  (`posters/{media_id}/...`).
- **Server-side secrets**: `@vercel/blob` reads `BLOB_READ_WRITE_TOKEN` from the
  server env; `lib/db` reads `DATABASE_URL`. Neither is ever returned or logged.
- **Heavily-commented, idempotency-first modules**: New files match the existing
  comment density and reference the requirement clauses they satisfy.

### Important schema note (live vs. dump)

`schema.sql` is a stale `pg_dump` and shows a `media_type` column, but the LIVE
schema and all runtime code use a `type` column (the confirm route inserts into
`type`, the GET endpoint selects `media.type`, and the DTO exposes `type`). The
same staleness was already recorded in `migrations/002_add_upload_id_column.sql`
("schema.sql is stale per audit Finding 1.9"). This design targets the LIVE
schema: the "is this a video?" decision uses the value that runtime code already
stores in `type`, which is a MIME string beginning with `video/` (e.g.
`video/mp4`). Where the requirements say `media_type = 'video'`, the concrete
predicate against the live table is `type LIKE 'video/%'`. This is called out
explicitly in the enqueue helper and backfill so the migration file can be
adjusted to the deployed column name at implementation time without changing the
design.

## Architecture

The system has two independent runtimes that share only the Neon database and
Vercel Blob: the existing **Vercel app** (serverless request path) and the new
**Railway worker** (long-running process). They never call each other directly;
the `poster_jobs` table is the sole coordination point.

```mermaid
flowchart TD
    subgraph Browser
        U[User uploads video direct-to-Blob]
    end

    subgraph Vercel[Vercel serverless app]
        CR[Confirm_Route<br/>media/confirm]
        WH[Webhook_Path<br/>upload-token onUploadCompleted]
        EP[Event_Endpoint<br/>GET /api/event/:slug]
        EQ[[lib/poster-jobs.ts<br/>enqueuePosterJob]]
    end

    subgraph DB[(Neon Postgres)]
        M[(public.media<br/>+ poster_url)]
        PJ[(public.poster_jobs<br/>queue)]
    end

    subgraph Railway[Railway Poster_Worker]
        POLL[Poll loop]
        CLAIM[Claim: FOR UPDATE SKIP LOCKED<br/>status=pending, run_after<=now]
        FF[ffmpeg: seek early frame + downscale]
        UP[Upload poster to Blob<br/>posters/:media_id/...]
        DBU[UPDATE media SET poster_url<br/>+ job status=done]
    end

    B1[(Vercel Blob<br/>video bytes)]
    B2[(Vercel Blob<br/>poster image)]

    subgraph Gallery[Frontend gallery]
        G[media-item.tsx]
    end

    U -->|bytes| B1
    U -->|confirm| CR
    B1 -.->|onUploadCompleted| WH
    CR -->|video row created / exists| EQ
    WH -->|video row inserted / no-op| EQ
    EQ -->|INSERT ... ON CONFLICT DO NOTHING| PJ
    CR --> M
    WH --> M

    POLL --> CLAIM
    CLAIM -->|claim pending job| PJ
    CLAIM -->|read content URL| M
    CLAIM --> FF
    FF -->|read ranged input| B1
    FF --> UP
    UP --> B2
    UP --> DBU
    DBU -->|poster_url| M
    DBU -->|status=done| PJ

    EP -->|SELECT incl. poster_url| M
    EP -->|Media_DTO| G
    G -->|poster_url present| B2
```

### Flow summary

1. **Upload → enqueue.** A video row is created by the `Confirm_Route` (same
   session) or reconciled by the `Webhook_Path` (production webhook). Each path
   calls `enqueuePosterJob(media_id)` for videos only. The insert is idempotent,
   so the two paths converge on at most one job per `media_id`
   (Requirements 3, 4, 5).
2. **Worker claim.** The Railway worker polls, claims due `pending` jobs with
   `FOR UPDATE SKIP LOCKED`, and flips them to `processing` inside the claiming
   transaction (Requirement 7).
3. **ffmpeg → blob → db.** The worker seeks an early frame from the video's
   `content` URL, downscales it, uploads the poster under `posters/{media_id}/`,
   then `UPDATE media SET poster_url = ...` and marks the job `done`
   (Requirement 8). Failures increment `attempts` and reschedule with backoff up
   to `Max_Attempts` (Requirements 9, 17).
4. **Gallery.** The `Event_Endpoint` returns `poster_url` in each `Media_DTO`.
   The gallery shows a placeholder while `poster_url` is `null` and renders
   `<video poster preload="none">` once it is set (Requirements 11, 12).

### Why a Postgres-backed queue

`SELECT ... FOR UPDATE SKIP LOCKED` gives safe, contention-free multi-worker
claiming without a broker. It reuses the Neon database already accessed via
`DATABASE_URL`, keeps the operational surface tiny, and matches the requirement
to introduce no new managed queue product (Requirement 2.5, 2.6).

## Components and Interfaces

### Component 1: Migration `migrations/004_add_poster_url_and_poster_jobs.sql`

A single numbered migration (following the `002`/`003` convention) that:

- Adds a nullable `poster_url text` column to `public.media` (Requirement 1).
- Creates `public.poster_jobs` with the queue columns, `status` check
  constraint, a unique index on `media_id`, and a claim-supporting index on
  `(status, run_after)` (Requirement 2).
- Documents a rollback that drops the table, index, and column in reverse order
  (Requirements 1.5, 1.7).

The migration is additive and reversible; it modifies no existing column,
constraint, index, or data on `public.media` (Requirement 1.4). It runs as a
single unit so a failure applies nothing partial (Requirement 1.7).

### Component 2: Enqueue helper `lib/poster-jobs.ts`

A small shared library, following the pattern of `lib/section-match.ts` (a pure,
heavily-commented helper that takes a `Pool`/executor and returns a value). It
centralizes the queue-write contract so both enqueue paths behave identically.

```ts
import type { Pool, PoolClient } from 'pg';

// A minimal executor type so the helper works with the shared pool OR a
// transaction client (both expose .query with the same signature).
type Executor = Pick<Pool | PoolClient, 'query'>;

/**
 * Idempotently enqueue a poster job for a video media row.
 *
 * Idempotency is enforced by the DATABASE: the unique index on
 * poster_jobs.media_id makes `ON CONFLICT (media_id) DO NOTHING` the atomic
 * dedupe primitive (mirrors the media_upload_id_key pattern used by the
 * confirm/webhook routes). Calling this once or many times for the same
 * media_id yields exactly one job (Req 5.1, 5.2, 5.3).
 *
 * The new job is created with status = 'pending', attempts = 0, and
 * run_after = now() so it is immediately eligible for claiming (Req 3.4).
 *
 * Returns true if a NEW job row was inserted, false if one already existed
 * (conflict). Callers use the boolean only for logging; correctness does not
 * depend on it.
 *
 * This function NEVER throws for the "already exists" case. It DOES surface a
 * genuine database error to the caller, which decides how to handle it:
 *   - Confirm_Route swallows-and-logs (Req 3.5): media creation already
 *     succeeded and must not be failed by an enqueue error.
 *   - Webhook_Path rethrows so Vercel Blob retries the webhook (Req 4.4).
 */
export async function enqueuePosterJob(
    db: Executor,
    mediaId: number,
): Promise<boolean> {
    const result = await db.query(
        `INSERT INTO poster_jobs (media_id, status, attempts, run_after, created_at, updated_at)
         VALUES ($1, 'pending', 0, now(), now(), now())
         ON CONFLICT (media_id) DO NOTHING`,
        [mediaId],
    );
    return (result.rowCount ?? 0) > 0;
}

/**
 * True when a media row's stored type denotes a video. The LIVE column is
 * `type`, a MIME string (e.g. 'video/mp4'); videos begin with 'video/'. This
 * predicate is the single source of truth for "should we enqueue?" so both
 * enqueue paths and the backfill agree (Req 3.2, 4.3, 13.2).
 */
export function isVideoType(type: string | null | undefined): boolean {
    return typeof type === 'string' && type.startsWith('video/');
}
```

### Component 3: `Confirm_Route` wiring (`app/api/event/[event-slug]/media/confirm/route.ts`)

The route already resolves to exactly one media row per `upload_id` via
`ON CONFLICT (upload_id) DO NOTHING` and returns 201 (new) or 200 (existing).
After the row is committed and shaped — on BOTH the newly-inserted branch and
the already-exists branch — the route calls `enqueuePosterJob` when the row is a
video (Requirements 3.1, 3.3):

- Only for videos: guard with `isVideoType(row.type)` (Requirement 3.2).
- New jobs are `pending` (Requirement 3.4), guaranteed by the helper.
- Enqueue failure must not fail media creation: the call is wrapped in
  `try/catch`; on error the route logs non-secret context and still returns the
  successful media response (Requirement 3.5). The enqueue runs AFTER the media
  row is definitively persisted, so a swallowed enqueue error leaves a valid
  media row with no job (the backfill or a later webhook retry can still create
  the job).

### Component 4: `Webhook_Path` wiring (`app/api/event/[event-slug]/media/upload-token/route.ts`)

Inside `onUploadCompleted`, after the idempotent media INSERT:

- Determine whether the row is a video from the completed blob's content type
  (`blob.contentType`, already used as the inserted `type`), via `isVideoType`
  (Requirement 4.3).
- Resolve the `media_id` for this `upload_id` (the INSERT uses
  `ON CONFLICT DO NOTHING` without `RETURNING`, so on the no-op branch we
  `SELECT media_id FROM media WHERE upload_id = $1`). This makes enqueue work on
  BOTH the freshly-inserted and already-existing branches (Requirements 4.1, 4.2).
- Call `enqueuePosterJob(pool, media_id)`.
- Error semantics differ from the confirm route: because the webhook has no
  user-facing response and Vercel Blob retries on throw, a transient enqueue DB
  error is rethrown so the webhook is retried (Requirement 4.4). The
  `ON CONFLICT DO NOTHING` guarantees the retry cannot create a duplicate
  (Requirements 4.5, 5.1).

Combined, the two paths create at most one job per `media_id` because both funnel
through the same unique-index-backed insert (Requirement 4.5).

### Component 5: `Poster_Worker` service (`worker/`)

A separate, long-running Node service in the same repo, NOT part of the Vercel
request path (Requirements 6.1, 6.2). Proposed layout:

```
worker/
  package.json          # own deps: pg, @vercel/blob, sharp (fluent-ffmpeg optional)
  tsconfig.json
  Dockerfile            # node base image + ffmpeg installed at build time
  railway.json          # Railway deploy config (build + start command, restart policy)
  src/
    index.ts            # entry point: config load, start poll loop, graceful shutdown
    config.ts           # env parsing (DATABASE_URL, BLOB_READ_WRITE_TOKEN, tunables)
    db.ts               # pg Pool for the worker (reads DATABASE_URL)
    queue.ts            # claim/complete/fail/reclaim SQL (the queue state machine)
    process-job.ts      # per-job pipeline: content URL -> ffmpeg -> blob -> db
    frame.ts            # ffmpeg invocation + downscale (frame extraction)
    logger.ts           # structured, secret-free logging
    backfill.ts         # one-time backfill command (Req 13)
```

Interfaces (worker-internal):

```ts
// queue.ts
interface PosterJob {
    id: number;
    media_id: number;
    status: 'pending' | 'processing' | 'done' | 'failed';
    attempts: number;
    run_after: string; // ISO timestamp
}

// Claim up to `limit` due pending jobs, flipping them to 'processing' in one
// transaction. Uses FOR UPDATE SKIP LOCKED so concurrent workers never claim
// the same row (Req 7.1, 7.2, 7.5).
function claimJobs(limit: number): Promise<PosterJob[]>;

// Mark a job done after poster_url is written (Req 8.5).
function completeJob(jobId: number): Promise<void>;

// Increment attempts; reschedule as 'pending' with backoff, or mark 'failed'
// at Max_Attempts (Req 9.1-9.4).
function failJob(jobId: number, attempts: number): Promise<void>;

// Reclaim stale 'processing' jobs whose updated_at is older than the
// stale-processing timeout, returning them to 'pending' (Req 10.2).
function reclaimStaleProcessing(timeoutSeconds: number): Promise<number>;
```

The poll loop, claiming SQL, concurrency, and retry policy are detailed under
[Worker Runtime Design](#worker-runtime-design).

### Component 6: Media DTO + Event endpoint + Confirm response (Requirement 11)

- `app/dto/media.ts`: add `poster_url: string | null` to the `Media` interface
  (Requirement 11.1).
- `app/api/event/[event-slug]/route.ts`: add `media.poster_url` to the GET
  SELECT column list and map it into each `Media` item; a `NULL` column becomes
  `null` in the DTO (Requirements 11.2, 11.3).
- `app/api/event/[event-slug]/media/confirm/route.ts`: `shapeMediaRow` includes
  `poster_url: row.poster_url ?? null` so a freshly created video (which has no
  poster yet) returns `poster_url: null`, matching the DTO shape
  (Requirement 11.4).

### Component 7: Frontend gallery (`app/components/media-item.tsx`, Requirement 12)

The video branch is updated to accept an optional `poster_url` prop (threaded
from `masonry.tsx`, sourced from `Media.poster_url`) and:

- When `poster_url` is present, render `<video poster={poster_url} preload="none" ...>`
  (Requirements 12.2, 12.3).
- When `poster_url` is `null`, keep reserving layout space and show a
  placeholder using the existing reserve-space approach plus the existing
  play-button overlay (Requirement 12.1). No blocking on poster availability —
  rendering is synchronous with the current data (Requirement 12.4).
- If the poster fails to load or does not appear within a configured timeout,
  fall back to the placeholder so every slot shows a visible element
  (Requirement 12.5). This reuses the component's existing `errored` state
  pattern (`onError`) plus a `setTimeout` guard cleared on successful poster
  load.
- Videos with no poster still play when opened (Requirement 15.1), unchanged.

### Component 8: Backfill (`worker/src/backfill.ts`, Requirement 13)

A one-time command (run via a Railway one-off or `node worker/dist/backfill.js`)
that enqueues jobs for existing videos idempotently. It performs a single
set-based, idempotent insert (no per-row round trips):

```sql
INSERT INTO poster_jobs (media_id, status, attempts, run_after, created_at, updated_at)
SELECT m.media_id, 'pending', 0, now(), now(), now()
FROM media m
WHERE m.type LIKE 'video/%'          -- videos only (Req 13.2)
  AND m.poster_url IS NULL           -- no poster yet (Req 13.1)
ON CONFLICT (media_id) DO NOTHING;   -- no duplicate jobs (Req 13.3)
```

`ON CONFLICT (media_id) DO NOTHING` covers "has no existing job" and makes reruns
create no duplicates (Requirements 13.1, 13.3). The statement only inserts into
`poster_jobs` and never touches `media` or its `content` (Requirement 13.4).

## Data Models

### `public.media` (existing, one additive column)

```
media_id     serial PK        (existing)
user_id      serial           (existing)
content      varchar(255)     (existing) -- video/image Blob URL
type         varchar          (existing, LIVE) -- MIME; videos begin 'video/'
date         date             (existing)
section_id   integer NULL     (existing)
event_id     serial           (existing)
upload_id    uuid NULL        (existing, migration 002)
poster_url   text NULL        (NEW)  -- Vercel Blob URL of the poster; NULL = none yet
```

- `poster_url` is nullable with no default; every existing row stays valid with
  `poster_url = NULL`, interpreted as "no poster ready yet"
  (Requirements 1.1, 1.3, 1.6).

### `public.poster_jobs` (new)

```
id          bigserial PK
media_id    integer NOT NULL REFERENCES public.media(media_id)
status      text    NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','processing','done','failed'))
attempts    integer NOT NULL DEFAULT 0
run_after   timestamptz NOT NULL DEFAULT now()
created_at  timestamptz NOT NULL DEFAULT now()
updated_at  timestamptz NOT NULL DEFAULT now()

UNIQUE INDEX poster_jobs_media_id_key ON poster_jobs (media_id)   -- Req 2.4, 5.2
INDEX        poster_jobs_claim_idx    ON poster_jobs (status, run_after) -- claim support
```

- The unique index on `media_id` enforces at most one job per media row
  (Requirements 2.4, 4.5, 5.1) and backs `ON CONFLICT (media_id) DO NOTHING`
  (Requirement 5.2).
- `status` is constrained to the four lifecycle values (Requirement 2.3).
- `attempts` and `updated_at` retain processing history for observability
  (Requirement 16.4).
- The `(status, run_after)` index makes claim scans efficient.

### Migration SQL (`migrations/004_add_poster_url_and_poster_jobs.sql`)

```sql
-- Migration: Add media.poster_url and the public.poster_jobs queue table.
-- Purpose: Enable asynchronous, worker-generated video posters. media.poster_url
--          records the generated poster's Blob URL (NULL = none yet). poster_jobs
--          is a durable, Postgres-backed job queue (no new managed queue product):
--          one job per media_id (unique index) enables idempotent enqueue via
--          ON CONFLICT (media_id) DO NOTHING, mirroring media_upload_id_key.
-- Requirements: 1.1-1.7, 2.1-2.6, 5.2, 16.4
-- Notes: Additive and reversible. poster_url is nullable with no default, so all
--        existing media rows stay valid (poster_url NULL). No existing column,
--        constraint, index, or data on public.media is modified (Req 1.4). Runs as
--        a single unit; a failure applies nothing partial (Req 1.7).

-- 1. Additive nullable column on media (Req 1.1, 1.3).
ALTER TABLE public.media
  ADD COLUMN poster_url text;

-- 2. Durable job queue (Req 2.1, 2.2, 2.3).
CREATE TABLE public.poster_jobs (
    id          bigserial PRIMARY KEY,
    media_id    integer     NOT NULL REFERENCES public.media(media_id),
    status      text        NOT NULL DEFAULT 'pending',
    attempts    integer     NOT NULL DEFAULT 0,
    run_after   timestamptz NOT NULL DEFAULT now(),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT poster_jobs_status_check
        CHECK (status IN ('pending', 'processing', 'done', 'failed'))
);

-- 3. At most one job per media_id — the atomic dedupe primitive for enqueue
--    (Req 2.4, 5.2).
CREATE UNIQUE INDEX poster_jobs_media_id_key
    ON public.poster_jobs (media_id);

-- 4. Claim-scan support: pending jobs due to run, cheapest first.
CREATE INDEX poster_jobs_claim_idx
    ON public.poster_jobs (status, run_after);

-- Rollback (reverse order: drop the queue table and its indexes, then the
-- media column). Restores the schema to its pre-migration state (Req 1.5, 1.7):
-- DROP INDEX IF EXISTS public.poster_jobs_claim_idx;
-- DROP INDEX IF EXISTS public.poster_jobs_media_id_key;
-- DROP TABLE IF EXISTS public.poster_jobs;
-- ALTER TABLE public.media DROP COLUMN IF EXISTS poster_url;
```

### Worker Runtime Design

**Configuration (env, parsed in `worker/src/config.ts`):**

| Env var | Meaning | Req |
| --- | --- | --- |
| `DATABASE_URL` | Neon connection string (secret) | 6.3, 14.1 |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob token (secret) | 6.3, 14.1 |
| `POSTER_WORKER_CONCURRENCY` | Bounded concurrency N (>=1, default e.g. 2) | 7.3, 7.6 |
| `POSTER_MAX_ATTEMPTS` | Max_Attempts before `failed` (default e.g. 5) | 9.6 |
| `POSTER_POLL_INTERVAL_MS` | Delay between poll cycles when idle | 6.4 |
| `POSTER_STALE_PROCESSING_SECONDS` | Reclaim timeout for stuck `processing` | 10.2 |
| `POSTER_MAX_DIMENSION` | Max poster width/height in px | 8.2 |
| `POSTER_BACKOFF_BASE_SECONDS` | Base for exponential backoff | 9.2, 9.3 |

**Poll loop (`index.ts`):** On start, log a secret-free startup line and begin a
repeating cycle (Requirement 6.4). Each cycle:

1. `reclaimStaleProcessing(POSTER_STALE_PROCESSING_SECONDS)` returns stuck
   `processing` jobs to `pending` (Requirement 10.2).
2. Compute free capacity `= N - inFlight`. If `0`, skip claiming this cycle
   (Requirement 7.4).
3. `claimJobs(freeCapacity)` claims due jobs (Requirement 7.1).
4. Dispatch each claimed job to `process-job.ts`, tracking in-flight count so
   simultaneous processing never exceeds `N` (Requirements 7.3, 7.4).
5. Sleep `POSTER_POLL_INTERVAL_MS` before the next cycle.

Graceful shutdown (SIGTERM/SIGINT) stops claiming and waits for in-flight jobs to
finish so no job is abandoned mid-write.

**Claiming SQL (`queue.ts`):** A single statement claims and transitions atomically:

```sql
UPDATE poster_jobs
SET status = 'processing', updated_at = now()
WHERE id IN (
    SELECT id FROM poster_jobs
    WHERE status = 'pending' AND run_after <= now()
    ORDER BY run_after
    FOR UPDATE SKIP LOCKED
    LIMIT $1
)
RETURNING id, media_id, status, attempts, run_after;
```

- `FOR UPDATE SKIP LOCKED` guarantees a given job is claimed by at most one
  worker per poll cycle even under concurrent polling (Requirements 7.1, 7.5).
- The `status = 'processing'` transition happens before frame extraction begins
  (Requirement 7.2).
- `failed` jobs are never selected (`status = 'pending'` filter), so they are not
  reclaimed (Requirement 9.5).

**Per-job pipeline (`process-job.ts`):**

1. Load the media row (`content` URL, `type`, `poster_url`) for the job's
   `media_id`.
2. **Processing idempotency**: if `poster_url` is already non-null, mark the job
   `done` and skip generation (Requirement 10.1). This makes a re-run after a
   crash/timeout safe.
3. Extract an early frame with ffmpeg from the `content` URL and downscale it to
   at most `POSTER_MAX_DIMENSION` (Requirements 8.1, 8.2).
4. Upload the poster to Vercel Blob under `posters/{media_id}/poster.<ext>`
   using `BLOB_READ_WRITE_TOKEN` from the env (Requirements 8.3, 8.6).
5. `UPDATE media SET poster_url = $1 WHERE media_id = $2` with the single, final
   Blob URL — written only after a successful upload, never a partial value
   (Requirements 8.4, 10.3, 10.4).
6. `completeJob(id)` sets status `done` (Requirement 8.5).
7. Any thrown error routes to `failJob` (see retry policy). On failure, the
   media `poster_url` is left untouched (Requirements 17.3, 8.4).

**Frame extraction (`frame.ts`, Requirement 8):** Invoke the `ffmpeg` binary
(provided by the Docker image) reading from the video's public `content` URL and
seeking an early timestamp, emitting a single downscaled frame. Preferred form:

```
ffmpeg -ss 00:00:01 -i "<content_url>" -frames:v 1 -vf "scale='min(MAXDIM,iw)':-2" -f image2 pipe:1
```

- **Ranged/streamed input tradeoff**: ffmpeg over HTTP issues Range requests and
  stops reading once it has decoded the requested early frame, so it typically
  does NOT download the whole file — the ideal case for large videos. The
  tradeoff: some containers store the moov atom at the end (especially certain
  mobile recordings), forcing ffmpeg to seek to the tail before decoding, which
  reads more of the file. The worker therefore treats "content not retrievable"
  and "cannot decode a frame" as normal failure paths (Requirements 17.1, 17.2)
  rather than assuming a cheap read always succeeds. If early-seek fails, a
  bounded fallback (seek `0`) is attempted before failing the job.
- **Downscale**: `scale` in the ffmpeg filter caps the dimension; the frame is
  then re-encoded to a small JPEG/WebP. `sharp` (already a dependency) may
  perform the final encode/quality step by piping ffmpeg's frame into it, which
  keeps encoding consistent with the rest of the app. Either path produces one
  small poster image (Requirement 8.2).

**Retry and backoff (`failJob`, Requirement 9):** On any processing failure:

```sql
UPDATE poster_jobs
SET attempts = attempts + 1,
    status = CASE WHEN attempts + 1 >= $2 THEN 'failed' ELSE 'pending' END,
    run_after = CASE WHEN attempts + 1 >= $2
                     THEN run_after
                     ELSE now() + ($3 * power(2, attempts)) * interval '1 second'
                END,
    updated_at = now()
WHERE id = $1;
```

- `attempts` is incremented every failure (Requirement 9.1).
- Below `Max_Attempts`: status returns to `pending` with a future `run_after`
  computed by exponential backoff that grows with `attempts`
  (Requirements 9.2, 9.3).
- At `Max_Attempts`: status becomes `failed` and is never reclaimed
  (Requirements 9.4, 9.5).
- A single bad video fails cleanly without stalling others; the loop continues
  claiming and processing other jobs (Requirements 17.1, 17.2, 17.4).

**Deployment (`worker/Dockerfile`, `worker/railway.json`, Requirement 6.5):** A
Docker image based on a Node runtime with `ffmpeg` installed at build time
(`apt-get install -y ffmpeg` on a Debian-based image, or the `ffmpeg` nix
package via nixpacks). `railway.json` pins the Dockerfile builder and the start
command (`node dist/index.js`) with an always-restart policy so the long-running
worker is supervised by Railway (Requirements 6.1, 6.5).

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all
valid executions of a system — essentially, a formal statement about what the
system should do. Properties serve as the bridge between human-readable
specifications and machine-verifiable correctness guarantees.*

The following properties are validated with property-based tests (fast-check +
vitest, already used in this repo). The queue state machine (enqueue, claim,
complete, fail, reclaim) is pure relative to its SQL contract, so it is modeled
as an in-memory reference implementation of `poster_jobs` and exercised across
randomized job/media sequences. Effectful boundaries (ffmpeg, Blob upload,
network) are mocked; those are covered by example/integration tests in the
Testing Strategy rather than property tests.

### Property 1: Enqueue idempotency — at most one job per media_id

*For any* media id and *any* sequence of one or more `enqueuePosterJob` calls for
that media id (in any order, with any interleaving of the two enqueue paths), the
final set of poster jobs contains exactly one job for that media id.

**Validates: Requirements 2.4, 4.5, 5.1, 5.2, 5.3, 3.3, 4.2**

### Property 2: Enqueue is video-only

*For any* media row, `enqueuePosterJob` is invoked by an enqueue path if and only
if the row's `type` denotes a video (`isVideoType` true); no poster job is ever
created for a non-video media row.

**Validates: Requirements 3.1, 3.2, 4.1, 4.3, 13.2**

### Property 3: A done job implies a non-null poster_url

*For any* sequence of worker operations over any set of jobs, whenever a job's
status is `done`, the corresponding media row's `poster_url` is non-null.

**Validates: Requirements 8.4, 8.5, 10.1, 10.4**

### Property 4: Failure never overwrites poster_url

*For any* job whose processing fails (including ffmpeg-cannot-decode and
content-not-retrievable), the corresponding media row's `poster_url` is left
exactly as it was before the attempt — never cleared, never set to a partial
value.

**Validates: Requirements 8.4, 10.4, 17.1, 17.2, 17.3**

### Property 5: SKIP LOCKED gives exclusive claims

*For any* set of due `pending` jobs and *any* number of concurrent workers each
claiming a batch, every job is claimed by at most one worker per poll cycle, and
every claimed job is transitioned to `processing`.

**Validates: Requirements 7.1, 7.2, 7.5**

### Property 6: Bounded concurrency is respected

*For any* configured concurrency `N >= 1` and *any* arrival pattern of due jobs,
the number of jobs simultaneously in `processing` by a single worker never
exceeds `N`.

**Validates: Requirements 7.3, 7.4, 7.6**

### Property 7: Retry increments attempts and backoff is non-decreasing

*For any* job that fails while `attempts + 1 < Max_Attempts`, the failure
increments `attempts` by exactly one and sets a strictly future `run_after`, and
the computed backoff delay is non-decreasing as `attempts` increases.

**Validates: Requirements 9.1, 9.2, 9.3**

### Property 8: Max_Attempts terminates retries and failed jobs are never reclaimed

*For any* job that fails when `attempts + 1 >= Max_Attempts`, its status becomes
`failed`, and *for any* subsequent claim cycle, a `failed` job is never selected.

**Validates: Requirements 9.4, 9.5**

### Property 9: Processing idempotency (re-run safety)

*For any* job whose media row already has a non-null `poster_url`, processing the
job transitions it to `done` without producing a new poster image and without
changing the existing `poster_url`.

**Validates: Requirements 10.1, 10.3, 10.4**

### Property 10: Stale-processing jobs become reclaimable

*For any* job left in `processing` whose `updated_at` is older than the
stale-processing timeout, a reclaim cycle returns it to `pending` so it becomes
eligible for claiming again; jobs within the timeout are not reclaimed.

**Validates: Requirements 10.2, 10.3**

### Property 11: Poster blob path is namespaced by media_id

*For any* successfully processed job, the uploaded poster's Blob path is under the
`posters/{media_id}/` namespace derived from that job's `media_id`.

**Validates: Requirements 8.3, 8.6**

### Property 12: DTO exposes poster_url faithfully

*For any* media row, the Media_DTO produced by the event endpoint and the confirm
response has `poster_url` equal to the row's stored value, and `null` exactly when
the stored value is `NULL`.

**Validates: Requirements 11.1, 11.2, 11.3, 11.4, 15.4**

### Property 13: One failing job does not block others

*For any* batch of claimed jobs where an arbitrary subset fails, every
non-failing job in the batch is still processed to completion in the same worker
run.

**Validates: Requirements 17.4**

## Error Handling

- **Enqueue failure on the confirm path** (Requirement 3.5): wrapped in
  `try/catch`; the media response is returned regardless, and a non-secret line
  is logged (`media_id`, error message). Media creation is never failed by an
  enqueue error.
- **Enqueue failure on the webhook path** (Requirement 4.4): a transient DB error
  is rethrown so Vercel Blob retries the webhook; `ON CONFLICT DO NOTHING` makes
  the retry safe (no duplicate job).
- **Video not retrievable / ffmpeg cannot decode** (Requirements 17.1, 17.2):
  treated as a job failure → increment `attempts`, apply backoff, and eventually
  `failed`. The media `poster_url` is left unchanged (Requirement 17.3).
- **Worker crash mid-processing** (Requirement 10.2): the job stays `processing`
  until the stale-processing timeout, after which reclaim returns it to
  `pending`. Because a partial `poster_url` is never written (the update is the
  final step), reprocessing is safe (Requirements 10.3, 10.4).
- **Blob upload failure**: treated as a job failure; `poster_url` is not written,
  so the job retries with backoff.
- **Partial writes forbidden** (Requirement 10.4): `poster_url` is set only after
  a fully successful upload, as a single URL value.
- **Migration failure** (Requirement 1.7): the migration runs as one unit; on
  failure it is rolled back with the documented rollback so no partial change
  remains.
- **Poster load failure/timeout in the gallery** (Requirement 12.5): the video
  element's `onError` and a timeout guard flip to the placeholder so every slot
  shows a visible element.
- **Secrets** (Requirements 14.2, 14.3, 14.4): `DATABASE_URL` and
  `BLOB_READ_WRITE_TOKEN` are read only from env, never returned in any response,
  and never logged. Error logs carry only non-secret context (`media_id`,
  `attempts`, a short error description).

## Testing Strategy

This repo uses **vitest** with **fast-check** for property-based testing. The
feature spans pure queue logic (well suited to PBT), effectful I/O (ffmpeg, Blob,
network — suited to mocks/integration), IaC-like deployment config (suited to
presence/shape checks), and UI (suited to example/interaction tests).

### Property-based tests (fast-check, vitest)

Each property in the Correctness Properties section is implemented as a SINGLE
property-based test running a minimum of 100 iterations, tagged with a comment:
`Feature: video-poster-generation, Property {number}: {property_text}`.

- **Queue state machine (Properties 1, 3, 4, 5, 6, 7, 8, 9, 10, 13)** are tested
  against an in-memory reference model of `poster_jobs`/`media` that implements
  the same enqueue/claim/complete/fail/reclaim transitions as the SQL. fast-check
  generates randomized sequences of media rows (video/image), enqueue calls
  across both paths, concurrent claim batches, and failure injections.
  - Concurrency (Property 5) is modeled by generating multiple simultaneous claim
    batches over the same job set and asserting disjoint claims — mirroring
    `FOR UPDATE SKIP LOCKED` semantics.
- **Enqueue video-only (Property 2)** generates arbitrary `type` strings
  (including `video/*`, `image/*`, `null`) and asserts `isVideoType` gates
  enqueue.
- **Namespacing (Property 11)** generates arbitrary `media_id`s and asserts the
  computed poster path is under `posters/{media_id}/`.
- **DTO (Property 12)** generates media rows with `poster_url` string-or-null and
  asserts the DTO mapping preserves the value and nulls faithfully.

### Example-based unit tests

- `enqueuePosterJob`: inserts once, second call is a no-op (uses a test double or
  a transactional test DB) — a concrete check complementing Property 1.
- Confirm route: video insert enqueues; image insert does not; existing-row
  branch enqueues; enqueue error is swallowed and the media response still
  returns (Requirement 3.5).
- Webhook route: freshly-inserted and no-op branches both enqueue; transient
  enqueue error rethrows (Requirement 4.4).
- `failJob` backoff: concrete attempts values produce expected `run_after`
  ordering and the `failed` transition at `Max_Attempts`.

### Worker tests (how to test the long-running service)

- The poll loop is factored so a single "tick" (`reclaim → claim → dispatch`) is
  callable in isolation, allowing tests to drive the worker deterministically
  without an infinite loop or real timers.
- `frame.ts` is tested with a small fixture video: assert that a non-empty,
  correctly-downscaled image is produced. ffmpeg availability is a smoke test in
  the worker's own suite/CI image.
- Failure paths (unreachable URL, undecodable bytes) assert the job is failed and
  `poster_url` remains unchanged (integration-style with a mocked Blob and a
  transactional test DB).
- Blob upload is mocked in unit/property tests (avoids network cost); one
  integration test may exercise a real upload against a test store if available.

### IaC / deployment config

- `worker/Dockerfile` and `worker/railway.json` are validated by presence/shape
  checks (Dockerfile installs `ffmpeg`; railway config declares the start
  command and restart policy). No property tests — this is declarative config
  (Requirement 6.5).

### Frontend

- `media-item.tsx` is covered by example/interaction tests: renders
  `<video poster preload="none">` when `poster_url` is present; renders the
  placeholder + play-button overlay when `null`; falls back to the placeholder on
  poster `onError`/timeout (Requirement 12). Snapshot/interaction tests rather
  than PBT, since this is UI rendering.

### Secrets

- A test asserts that log output produced during a simulated failure contains
  neither `DATABASE_URL` nor `BLOB_READ_WRITE_TOKEN` values (Requirements 14.3,
  14.4).
