# Design Document: Media Transcoding & Original Preservation

## Overview

This feature turns the app into an **originals archive with an optimized delivery layer**. The upload path stops reducing media before storage; instead it uploads the **original** and the existing Railway worker generates a **display derivative** (downscaled image via `sharp`, transcoded video via `ffmpeg`) that becomes what the app serves. The original is always kept for future high-quality delivery (WeTransfer).

It builds directly on three things already in `origin/main`:

1. The **direct-to-Blob upload** handshake + confirm route + `onUploadCompleted` webhook, with `upload_id`-keyed idempotency.
2. The **Railway `Poster_Worker`** (`worker/`) — a long-running poll loop with a Postgres-backed queue (`poster_jobs`), bounded concurrency, retry/backoff, stale reclaim, secret-free logging, `sharp` + `ffmpeg` already available.
3. The **`media-item.tsx`** render path that already does "placeholder now, swap to poster when ready", which we mirror for "original now, swap to derivative when ready".

### Design principles carried over from the existing code

- **Correlation-key idempotency**: every job kind for a media row is unique; enqueue is `ON CONFLICT DO NOTHING`.
- **Write the final URL only after a successful upload** — never a partial value; scoped to one media row.
- **Secrets are env-only** on both Vercel and the worker; never returned or logged.
- **Additive, reversible, numbered migrations**; `schema.sql` is a stale `pg_dump` (documented in migrations 002/004/005) — the LIVE table is migration-driven.
- **Failures are normal**: a job that can't complete fails cleanly through retry/backoff and never crashes the poll loop.

## Column semantics (the crux of the design)

We keep **`media.content` = "what the app serves right now"** so the gallery query and the frontend barely change. We add columns for the original and to track derivative readiness.

| Column | Meaning |
| --- | --- |
| `content` (existing) | The URL the app serves. On upload it is the **original**; once a derivative is ready the worker rewrites it to the **derivative**. Legacy rows keep their existing value. |
| `original_url` (new, nullable) | The untouched original's Blob URL, preserved for WeTransfer. On new uploads, set at confirm time to the same value `content` initially holds. NULL on legacy rows = "`content` is the only version". |
| `poster_url` (existing) | Video poster still frame (unchanged). |
| `width` / `height` (existing) | Intrinsic dimensions for layout (unchanged). |

Rationale for reusing `content` as the served pointer (instead of adding a separate `display_url` the frontend must prefer):
- The event GET query and every consumer already read `content`; making the derivative *become* `content` means the "swap when ready" is a single-column update with zero frontend branching for the URL itself.
- The original is the new, additive concept, so it gets the new column. This keeps legacy rows correct with no data migration of `content`.

> Alternative considered: add `display_url` and keep `content` = original. Rejected because it forces every reader (GET, download, zoom, next/image) to learn a "prefer display_url else content" rule, and it changes what `content` means for existing rows. Reusing `content` as "served" localizes the change to the worker's final UPDATE.

## Architecture

```mermaid
flowchart TD
    subgraph Browser
        U[Upload ORIGINAL bytes direct-to-Blob<br/>no client compression]
    end

    subgraph Vercel[Vercel serverless app]
        CR[Confirm route<br/>set content=original, original_url=original]
        WH[onUploadCompleted webhook<br/>same, reconciliation]
        EP[GET /api/event/:slug]
        EQ[[lib/media-jobs.ts<br/>enqueue by kind]]
    end

    subgraph DB[(Neon Postgres)]
        M[(media<br/>content, original_url, poster_url, w/h)]
        MJ[(media_jobs queue<br/>kind: poster|image|video)]
    end

    subgraph Railway[Railway worker]
        POLL[Poll loop + bounded concurrency]
        CLAIM[Claim due jobs FOR UPDATE SKIP LOCKED]
        DISPATCH{job.kind}
        POST[poster: ffmpeg frame -> sharp]
        IMG[image: sharp downscale/re-encode]
        VID[video: ffmpeg transcode 1080p/H.264]
        WRITE[Upload derivative -> UPDATE media]
    end

    B1[(Blob: original)]
    B2[(Blob: derivative + poster)]

    subgraph Gallery
        G[media-item.tsx<br/>serve content; original is fallback until derivative lands]
    end

    U -->|original bytes| B1
    U -->|confirm| CR
    B1 -.->|webhook| WH
    CR -->|per kind| EQ
    WH -->|per kind| EQ
    EQ -->|ON CONFLICT DO NOTHING| MJ

    POLL --> CLAIM --> DISPATCH
    DISPATCH -->|poster| POST
    DISPATCH -->|image| IMG
    DISPATCH -->|video| VID
    POST --> WRITE
    IMG --> WRITE
    VID --> WRITE
    WRITE -->|content := derivative| M
    CLAIM --> MJ

    EP -->|content, original_url, poster_url| G
    G -->|content| B2
```

## Components and Interfaces

### Component 1: Migration `006_media_jobs_and_original_url.sql`

Additive, reversible, single-unit. It:

1. Adds `media.original_url text` (nullable). NULL on legacy rows = "`content` is the only version" (Req 1.5, 9.3).
2. Introduces a **`kind`** dimension to the job queue supporting `poster`, `image`, `video`.

**Queue evolution decision — extend `poster_jobs` vs. new `media_jobs`:** The design adds a `kind` column and makes the uniqueness `(media_id, kind)` instead of `(media_id)`. Two viable shapes:

- **Option A (chosen): rename/generalize into `media_jobs`** with columns `id, media_id, kind, status, attempts, run_after, created_at, updated_at`, a unique index on `(media_id, kind)`, and a claim index on `(status, run_after)`. Existing `poster_jobs` rows are migrated by inserting them as `kind='poster'`. This gives one queue, one worker claim query, and symmetric handling of all kinds.
- **Option B: keep `poster_jobs`, add `kind` + widen the unique index to `(media_id, kind)`.** Less churn but the table name lies about its contents.

Option A is chosen for clarity; the migration renames the table (or creates `media_jobs` and copies rows) and updates the unique/claim indexes. The migration documents the exact forward and rollback SQL. Existing poster jobs continue to function as `kind='poster'` (Req 5.5, 9.4).

> The migration file will note the stale-`schema.sql` caveat and target the LIVE table, consistent with migrations 002/004/005.

### Component 2: Enqueue helper `lib/media-jobs.ts` (generalizes `lib/poster-jobs.ts`)

A shared, pure, executor-taking helper mirroring `lib/poster-jobs.ts`:

```ts
export type MediaJobKind = 'poster' | 'image' | 'video';

// Idempotent enqueue for one (media_id, kind). Returns true if a new row was
// inserted, false on conflict. Never throws for the "already exists" case.
export async function enqueueMediaJob(
  db: Executor,
  mediaId: number,
  kind: MediaJobKind,
): Promise<boolean>;

// LIVE type predicate (unchanged semantics): a MIME beginning with 'video/'.
export function isVideoType(type: string | null | undefined): boolean;
export function isImageType(type: string | null | undefined): boolean;
```

Enqueue policy on media-row creation (confirm + webhook):
- **Image row** → enqueue `image`.
- **Video row** → enqueue `poster` (preserves current behavior) AND `video` (new transcode). Each is independent (Req 5.4).

`lib/poster-jobs.ts` is kept as a thin re-export/shim (or callers are updated) so existing imports don't break; the confirm route and webhook call `enqueueMediaJob` for the right kinds.

### Component 3: Confirm route + webhook changes

Both media-creation paths already `INSERT ... ON CONFLICT (upload_id) DO NOTHING`. Changes:

1. Add `original_url` to the INSERT column set, set to the same Blob URL that `content` gets on creation (the original the client uploaded). `content` = original at creation; the worker rewrites it later (Req 1.2, 3.3, 4.3).
2. Replace the video-only `enqueuePosterJobForVideo` call with kind-aware enqueue: images → `image`; videos → `poster` + `video`. Enqueue stays swallow-and-log in confirm (never fail media creation) and rethrow in the webhook (so Blob retries) — unchanged error policy (Req 5, 8.2).

No change to auth, demo guards, blob-namespace verification, or orphan cleanup.

### Component 4: Worker — kind-aware dispatch

The worker's `process-job.ts` currently hardcodes poster logic. We refactor it into a **dispatcher** that routes by `job.kind`, keeping the existing injectable-deps testability:

```ts
// process-job.ts (dispatch)
switch (job.kind) {
  case 'poster': return processPosterJob(job, deps);   // existing logic, extracted
  case 'image':  return processImageJob(job, deps);    // new: sharp downscale
  case 'video':  return processVideoJob(job, deps);    // new: ffmpeg transcode
}
```

Shared machinery (claim, complete, fail/backoff, reclaim, bounded concurrency, logging) is untouched — only the per-kind body differs. Each kind:

- **poster** (`worker/src/frame.ts`, existing): ffmpeg early frame → `sharp` JPEG → upload `posters/{media_id}/poster.jpg` → `UPDATE media SET poster_url`. Idempotent on `poster_url` already set.
- **image** (`worker/src/image-derivative.ts`, new): fetch original from `content`/`original_url` → `sharp` resize to `IMAGE_MAX_DIMENSION` (fit inside, no enlargement), re-encode (WebP/JPEG) → upload `derivatives/{media_id}/image.<ext>` → `UPDATE media SET content = <derivative>`. If derivative not smaller, keep original as `content` and still complete (Req 3.5). Idempotency: skip if `content` already points at the derivative namespace.
- **video** (`worker/src/video-transcode.ts`, new): ffmpeg transcode original → H.264/AAC MP4 capped at `VIDEO_MAX_HEIGHT` (e.g. 1080) with a target bitrate/CRF → upload `derivatives/{media_id}/video.mp4` → `UPDATE media SET content = <derivative>`. On permanent failure, leave `content` = original (Req 4.5). Idempotency: skip if `content` already points at the derivative namespace.

**Derivative-readiness idempotency** (Req 3.6, 4.6): the served `content` URL living under the `derivatives/{media_id}/` namespace is the signal "derivative done". A re-run detects this and completes without regenerating — the same shape as poster's "poster_url already set" guard.

**New worker config** (env, `worker/src/config.ts`), all with safe defaults:

| Env var | Meaning | Default |
| --- | --- | --- |
| `IMAGE_MAX_DIMENSION` | Max image derivative edge (px) | 2000 |
| `IMAGE_QUALITY` | Image encoder quality | 80 |
| `VIDEO_MAX_HEIGHT` | Max transcoded video height (px) | 1080 |
| `VIDEO_CRF` / `VIDEO_BITRATE` | Transcode quality/bitrate target | CRF ~23 |
| `VIDEO_PRESET` | ffmpeg speed/size preset | veryfast |

Concurrency note: video transcode is CPU-heavy. `POSTER_WORKER_CONCURRENCY` (default 2) governs total in-flight jobs; because image/poster jobs are cheap and video jobs are heavy, the design keeps a single global concurrency knob for simplicity and notes that the Railway instance size is the real throughput lever. (A per-kind concurrency split is called out as a possible future refinement, not built now.)

### Component 5: DTO + Event GET

- `app/dto/media.ts`: add `original_url: string | null`. `content` continues to be the served URL.
- `GET /api/event/[event-slug]`: add `media.original_url` to the SELECT and map it into the DTO. No other query change (the big JOIN already returns `content`, `poster_url`, `blurhash`, `width`, `height`).

### Component 6: Frontend (`media-item.tsx`, zoom, download)

- **Images**: `src = content`. Since `content` is the original until the derivative lands and the derivative afterward, the existing `next/image` + blurhash + reserved-aspect-ratio path needs **no branching** — it just renders `content`. The "swap" happens naturally on the next load once the worker has rewritten `content`.
- **Videos**: unchanged poster placeholder → poster path; playback `src = content` (`preload="none"`).
- **Download / future WeTransfer**: the download route (and any future WeTransfer export) SHOULD use `original_url` when present (best quality) and fall back to `content`. This is the one place that deliberately prefers the original. (Wiring the download route to prefer `original_url` is included; building WeTransfer delivery is out of scope.)

### Component 7: Upload client (`lib/blob-upload-client.ts`, `lib/image-preprocess.ts`)

- Stop uploading the canvas-compressed image; upload the original `File` bytes (Req 2.1).
- Keep computing BlurHash and width/height from the decoded image for placeholder/layout, **without** substituting the uploaded bytes (Req 2.2, 2.3). `preprocessImage` is reduced to "measure + blurhash", or the upload wrapper simply ignores the processed blob and always sends the original while still using the measured metadata.
- Preserve concurrency cap, retries, IndexedDB resume, `upload_id` idempotency (Req 2.4).

### Component 8: Size cap

- Raise `MAX_FILE_SIZE` to an exaggerated guardrail (proposed **2 GB**) in all three enforcement points (client, upload-token `maximumSizeInBytes`, confirm) and keep them in sync (Req 7.1, 7.2).
- Ensure the client surfaces a clear message when exceeded (Req 7.3). Content-type validation unchanged (Req 7.4).

## Data flow: one image, one video (new model)

**Image upload:** browser uploads original → confirm sets `content = original_url = <original>`, enqueues `image` job → worker downscales with `sharp`, uploads `derivatives/{id}/image.webp`, sets `content = <derivative>`. Gallery serves original until the job finishes, then the derivative. Original kept for WeTransfer.

**Video upload:** browser uploads original → confirm sets `content = original_url = <original>`, enqueues `poster` + `video` jobs → poster job sets `poster_url`; video job transcodes to 1080p H.264, uploads `derivatives/{id}/video.mp4`, sets `content = <derivative>`. Gallery shows poster placeholder + plays original until transcode finishes, then plays the derivative. Original kept for WeTransfer.

## Correctness Properties

Using the repo's existing fast-check + vitest setup and the worker's injectable-deps design:

- **P1 — Enqueue idempotency per kind**: any sequence of `enqueueMediaJob(mediaId, kind)` yields exactly one job per `(mediaId, kind)`. (Req 5.1, 5.2)
- **P2 — Independent kinds**: a failing kind never transitions or blocks another kind for the same media row. (Req 5.4)
- **P3 — Final-URL atomicity**: `content` is rewritten to a derivative only after a successful upload; on failure `content` is left exactly as it was (original preserved). (Req 3.3, 4.3, 4.5, 8.4)
- **P4 — Derivative idempotency**: re-running a job whose `content` already points at the derivative namespace completes without regenerating or changing `content`. (Req 3.6, 4.6)
- **P5 — Original preserved**: `original_url` is never overwritten by derivative generation. (Req 1.3)
- **P6 — Legacy safety**: a row with `original_url IS NULL` renders by serving its existing `content` unchanged. (Req 9.1, 9.3)

Effectful boundaries (ffmpeg, sharp, Blob, network) are mocked in property tests and covered by example/integration tests, exactly as the existing worker tests do.

## Testing Strategy

- **Worker unit/property**: dispatch-by-kind; image derivative sizing/never-enlarge; video transcode success/failure→fallback; idempotent re-run; reuse existing poster tests unchanged.
- **Enqueue**: property test P1/P2 on `enqueueMediaJob`.
- **Route**: confirm/webhook set `original_url` and enqueue correct kinds; idempotent on repeat.
- **Frontend**: `media-item` renders `content` for image and video; poster fallback preserved.
- **Migration**: applies and rolls back cleanly; existing poster jobs survive as `kind='poster'`.
- **Cap**: all three enforcement points share the guardrail; oversize surfaces a message.

## Deployment / rollout notes

- Ship migration `006` first (additive; safe with old code — new columns unused until worker/app updated).
- Deploy worker with new kinds + config; deploy app (upload client stops compressing, confirm sets `original_url`, GET exposes it, cap raised).
- Optional backfill: enqueue `image`/`video` jobs for existing rows to derive them; poster backfill already exists and is unaffected.
- Cost re-estimation after implementation (requested by the owner) — see the re-estimation step in tasks.
