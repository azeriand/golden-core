# Requirements Document

## Introduction

This feature adds asynchronous, server-side generation of poster (thumbnail) images for uploaded videos so the gallery can show a consistent preview frame across devices. Today the gallery renders a bare `<video>` element with `preload="metadata"`. On desktop browsers this paints a first-frame preview, but on iOS Safari it paints nothing, leaving empty space where a video should be. Because uploads go direct-to-Blob from the browser and the Vercel serverless request path never holds the video bytes, poster generation cannot run inside the request path.

The solution introduces a separate, long-running worker service deployed to Railway. The worker consumes a job queue backed by the existing Neon Postgres database (using `SELECT ... FOR UPDATE SKIP LOCKED`, with no new managed queue product), extracts an early frame from each video with ffmpeg, downscales it to a small poster image, uploads that poster to Vercel Blob, and records the resulting poster URL on the media row. Work is throttled with bounded concurrency so a burst of uploads cannot overload the worker. A poster job is enqueued whenever a video media row is created — through both the same-session confirm route and the production `onUploadCompleted` webhook path. A one-time backfill enqueues jobs for existing videos that have no poster. The frontend shows a placeholder until a poster is ready, then renders `<video poster={poster_url}>`. Videos without a poster continue to work unchanged.

The implementation must preserve the codebase's existing idempotency conventions (correlation keys, unique indexes, `ON CONFLICT`), keep `DATABASE_URL` and `BLOB_READ_WRITE_TOKEN` server-side and out of logs, and remain fully backward compatible with existing media.

## Glossary

- **Media_Row**: A row in the existing `public.media` table representing one uploaded image or video. Identified by `media_id`. Videos are rows where `media_type = 'video'`.
- **Poster_Url**: A new nullable column (`poster_url`) on the `public.media` table holding the public Vercel Blob URL of a generated poster image for a video. `NULL` means "no poster is ready yet".
- **Poster_Image**: A downscaled still image extracted from an early frame of a video, uploaded to Vercel Blob and referenced by Poster_Url.
- **Poster_Job**: A unit of work describing "generate a poster for this Media_Row", persisted as a row in the Poster_Job_Table.
- **Poster_Job_Table**: A new Postgres table (`public.poster_jobs`) in the existing Neon database that serves as the durable job queue. It tracks status, attempt count, and scheduling metadata per Poster_Job.
- **Job_Status**: The lifecycle state of a Poster_Job, one of `pending`, `processing`, `done`, or `failed`.
- **Enqueue_Path**: Any server code path that creates a video Media_Row and must therefore create a Poster_Job. There are two production paths: the Confirm_Route and the Webhook_Path.
- **Confirm_Route**: The existing same-session route `app/api/event/[event-slug]/media/confirm/route.ts` that creates a Media_Row after a direct-to-Blob upload resolves.
- **Webhook_Path**: The existing production `onUploadCompleted` reconciliation handler in `app/api/event/[event-slug]/media/upload-token/route.ts` that creates a Media_Row when the client confirm did not.
- **Poster_Worker**: The separate, non-serverless worker service deployed to Railway that polls the Poster_Job_Table and generates posters. It is not part of the Vercel serverless request path.
- **Poll_Cycle**: One iteration in which the Poster_Worker claims and processes a batch of Poster_Jobs from the Poster_Job_Table.
- **Bounded_Concurrency**: A configured maximum number of Poster_Jobs the Poster_Worker processes simultaneously (a small integer N).
- **Ffmpeg**: The command-line tool used by the Poster_Worker to extract a video frame and produce an image.
- **Vercel_Blob**: The existing Vercel Blob object storage where video bytes and Poster_Images are stored.
- **Media_DTO**: The gallery data transfer object defined in `app/dto/media.ts` and assembled by the GET `/api/event/[event-slug]` endpoint.
- **Event_Endpoint**: The GET `/api/event/[event-slug]` API route that returns event sections and their Media_DTO items to the gallery.
- **Backfill_Process**: A one-time operation that enqueues Poster_Jobs for pre-existing video Media_Rows that have a `NULL` Poster_Url.
- **Upload_Id**: The existing client-generated UUID v4 correlation id stored in `media.upload_id`, used across the codebase for idempotent media creation.
- **Database_Url**: The `DATABASE_URL` environment variable granting access to the Neon Postgres database.
- **Blob_Token**: The `BLOB_READ_WRITE_TOKEN` environment variable granting read/write access to Vercel_Blob.
- **Retry_Backoff**: The delay applied before a failed Poster_Job becomes eligible to run again, increasing with attempt count.
- **Max_Attempts**: The configured maximum number of times a Poster_Job may be attempted before it is marked `failed`.

## Requirements

### Requirement 1: Poster URL Column and Migration

**User Story:** As a developer, I want a nullable poster URL column added to the media table via a migration, so that the system can record generated posters without breaking existing media.

#### Acceptance Criteria

1. THE Migration SHALL add a nullable column named `poster_url` of type text (or `character varying`) to the `public.media` table.
2. THE Migration SHALL follow the existing numbered migration file convention used by `migrations/002_add_upload_id_column.sql` and `migrations/003_media_section_id_nullable.sql`.
3. THE Migration SHALL leave every existing Media_Row valid with `poster_url` set to `NULL`.
7. IF the Migration cannot add the `poster_url` column, THEN THE Migration SHALL fail entirely and apply its rollback rather than leave a partial change.
4. THE Migration SHALL NOT modify, drop, or rename any existing column, constraint, index, or data in the `public.media` table.
5. THE Migration SHALL include a documented rollback statement that drops the `poster_url` column.
6. WHERE `poster_url` is `NULL` for a Media_Row, THE System SHALL interpret that Media_Row as having no poster ready yet.

### Requirement 2: Poster Job Table as Queue

**User Story:** As a developer, I want a Postgres job table used as the queue, so that poster work is durable and coordinated without introducing a new managed queue product.

#### Acceptance Criteria

1. THE Migration SHALL create a Poster_Job_Table named `public.poster_jobs` in the existing Neon database.
2. THE Poster_Job_Table SHALL include a `media_id` column referencing `public.media(media_id)`, a `status` column, an `attempts` count column, a `run_after` scheduling timestamp column, a `created_at` timestamp column, and an `updated_at` timestamp column.
3. THE Poster_Job_Table SHALL constrain `status` to the values `pending`, `processing`, `done`, and `failed`.
4. THE Poster_Job_Table SHALL enforce at most one Poster_Job per `media_id` using a unique index on `media_id`.
5. THE System SHALL NOT introduce any managed queue product, including message brokers or in-memory queue servers, for Poster_Job handling.
6. THE System SHALL use the existing Neon Postgres database, accessed via Database_Url, as the sole Poster_Job store.

### Requirement 3: Enqueue on Same-Session Confirm Path

**User Story:** As a user uploading a video in an active session, I want a poster job enqueued when my video media row is created, so that a preview frame is generated for my video.

#### Acceptance Criteria

1. WHEN the Confirm_Route creates a new video Media_Row, THE Confirm_Route SHALL create a corresponding Poster_Job for that `media_id`.
2. WHEN the Confirm_Route creates a Media_Row whose `media_type` is `image`, THE Confirm_Route SHALL NOT create a Poster_Job.
3. WHEN the Confirm_Route returns an idempotent response for an already-existing Media_Row, THE Confirm_Route SHALL ensure a Poster_Job exists for that video `media_id` without creating a duplicate Poster_Job.
4. WHEN a Poster_Job is created by the Confirm_Route, THE Confirm_Route SHALL set the new Poster_Job `status` to `pending`.
5. IF creation of a Poster_Job fails after the Media_Row is committed, THEN THE Confirm_Route SHALL return the successful media creation response and record the enqueue failure in server-side logs.

### Requirement 4: Enqueue on Production Webhook Path

**User Story:** As a user whose upload is reconciled by the production webhook, I want a poster job enqueued when the webhook creates my video media row, so that videos created outside the same-session confirm still get posters.

#### Acceptance Criteria

1. WHEN the Webhook_Path inserts a new video Media_Row, THE Webhook_Path SHALL create a corresponding Poster_Job for that `media_id`.
2. WHEN the Webhook_Path performs a no-op because the Media_Row already exists, THE Webhook_Path SHALL ensure a Poster_Job exists for that video `media_id` without creating a duplicate Poster_Job.
3. WHEN the Webhook_Path processes a Media_Row whose `media_type` is `image`, THE Webhook_Path SHALL NOT create a Poster_Job.
4. IF creation of a Poster_Job fails in the Webhook_Path due to a transient database error, THEN THE Webhook_Path SHALL allow the webhook to be retried.
5. WHERE a Media_Row `media_type` is `video`, THE Enqueue_Path behavior SHALL create at most one Poster_Job per `media_id` across the Confirm_Route and the Webhook_Path combined.

### Requirement 5: Idempotent Job Enqueue

**User Story:** As a developer, I want poster job enqueue to be idempotent per media_id, so that retries and dual creation paths never produce duplicate jobs.

#### Acceptance Criteria

1. WHEN a Poster_Job is enqueued for a `media_id` that already has a Poster_Job, THE System SHALL leave the existing Poster_Job unchanged and create no additional Poster_Job.
2. THE System SHALL enforce enqueue idempotency using the unique index on `poster_jobs.media_id` together with an `ON CONFLICT` clause on insert.
3. WHEN the same enqueue operation is executed more than once for a given `media_id`, THE System SHALL produce the same final set of Poster_Jobs as executing it once.

### Requirement 6: Worker Deployment and Isolation

**User Story:** As an operator, I want poster generation to run in a separate worker service on Railway, so that heavy CPU work never blocks the Vercel serverless request path.

#### Acceptance Criteria

1. THE Poster_Worker SHALL run as a separate, long-running service deployed to Railway.
2. THE Poster_Worker SHALL NOT run inside any Vercel serverless function or the Vercel request path.
3. THE Poster_Worker SHALL read Database_Url and Blob_Token from environment variables.
4. WHEN the Poster_Worker starts, THE Poster_Worker SHALL begin polling the Poster_Job_Table on a repeating Poll_Cycle.
5. THE Poster_Worker SHALL include a Railway-oriented deployment configuration that provides the Ffmpeg binary at runtime.

### Requirement 7: Job Claiming with Bounded Concurrency

**User Story:** As an operator, I want the worker to claim jobs safely and process a limited number at once, so that a burst of uploads does not cause CPU overload or duplicate processing.

#### Acceptance Criteria

1. WHEN the Poster_Worker claims Poster_Jobs, THE Poster_Worker SHALL select `pending` jobs whose `run_after` timestamp is at or before the current time using `SELECT ... FOR UPDATE SKIP LOCKED`.
2. WHEN a Poster_Job is claimed, THE Poster_Worker SHALL set the Poster_Job `status` to `processing` before beginning frame extraction.
3. THE Poster_Worker SHALL process at most Bounded_Concurrency Poster_Jobs simultaneously, where Bounded_Concurrency is a configured integer of at least 1.
4. WHILE the number of in-flight Poster_Jobs equals Bounded_Concurrency, THE Poster_Worker SHALL NOT claim additional Poster_Jobs.
5. WHEN two Poster_Worker processes poll concurrently, THE Poster_Worker SHALL ensure that a given Poster_Job is claimed by at most one process per Poll_Cycle.
6. THE Bounded_Concurrency value SHALL be configurable through an environment variable.

### Requirement 8: Frame Extraction and Poster Upload

**User Story:** As a user, I want a small preview image generated from an early frame of my video, so that the gallery can display a consistent poster.

#### Acceptance Criteria

1. WHEN the Poster_Worker processes a Poster_Job, THE Poster_Worker SHALL use Ffmpeg to extract an early frame from the video referenced by the Media_Row `content` URL.
2. WHEN a frame is extracted, THE Poster_Worker SHALL downscale the frame to a Poster_Image no larger than a configured maximum dimension.
3. WHEN a Poster_Image is produced, THE Poster_Worker SHALL upload the Poster_Image to Vercel_Blob using Blob_Token.
4. WHEN the Poster_Image upload succeeds, THE Poster_Worker SHALL update the corresponding Media_Row `poster_url` with the uploaded Poster_Image URL.
5. WHEN the Media_Row `poster_url` is updated, THE Poster_Worker SHALL set the Poster_Job `status` to `done`.
6. THE Poster_Worker SHALL store each Poster_Image under a namespaced Vercel_Blob path derived from the associated `media_id`.

### Requirement 9: Retry and Backoff on Failure

**User Story:** As an operator, I want failed poster jobs retried with backoff up to a limit, so that transient errors recover automatically without infinite retries.

#### Acceptance Criteria

1. IF processing a Poster_Job fails, THEN THE Poster_Worker SHALL increment the Poster_Job `attempts` count.
2. IF a Poster_Job fails AND the `attempts` count is below Max_Attempts, THEN THE Poster_Worker SHALL set the Poster_Job `status` to `pending` and set `run_after` to a future time computed by Retry_Backoff.
3. THE Retry_Backoff delay SHALL increase as the `attempts` count increases.
4. IF a Poster_Job fails AND the `attempts` count reaches Max_Attempts, THEN THE Poster_Worker SHALL set the Poster_Job `status` to `failed`.
5. WHILE a Poster_Job `status` is `failed`, THE Poster_Worker SHALL NOT claim that Poster_Job in subsequent Poll_Cycles.
6. THE Max_Attempts value SHALL be configurable through an environment variable.

### Requirement 10: Job Processing Idempotency and Retry Safety

**User Story:** As a developer, I want job processing to be safe to retry, so that a job re-run after a crash or timeout does not corrupt state or duplicate work.

#### Acceptance Criteria

1. WHEN the Poster_Worker processes a Poster_Job whose Media_Row already has a non-null `poster_url`, THE Poster_Worker SHALL set the Poster_Job `status` to `done` without generating a new Poster_Image.
2. IF the Poster_Worker crashes while a Poster_Job is `processing`, THEN THE Poster_Worker SHALL make that Poster_Job eligible for reclaiming after a configured stale-processing timeout.
3. WHEN a stale `processing` Poster_Job is reclaimed, THE Poster_Worker SHALL process the Poster_Job until it produces a valid Poster_Image output without a corrupt or partial `poster_url`.
4. WHEN the Poster_Worker updates a Media_Row `poster_url`, THE Poster_Worker SHALL write a single valid Poster_Image URL and never a partial value.

### Requirement 11: Media DTO and Event Endpoint Exposure

**User Story:** As a frontend developer, I want the poster URL included in the media data returned by the API, so that the gallery can render posters.

#### Acceptance Criteria

1. THE Media_DTO in `app/dto/media.ts` SHALL include a `poster_url` field of type string-or-null.
2. WHEN the Event_Endpoint returns Media_DTO items, THE Event_Endpoint SHALL include the `poster_url` value from each Media_Row.
3. WHERE a Media_Row has a `NULL` `poster_url`, THE Event_Endpoint SHALL return `poster_url` as `null` for that Media_DTO item.
4. THE Confirm_Route response object SHALL include the `poster_url` field so newly created media match the Media_DTO shape.

### Requirement 12: Frontend Placeholder Until Ready

**User Story:** As a user viewing the gallery, I want a placeholder shown until a video poster is ready and the poster shown once available, so that the gallery looks consistent across devices including iOS Safari.

#### Acceptance Criteria

1. WHILE a video Media_DTO item has a `null` `poster_url`, THE Gallery SHALL display a placeholder in place of a preview frame.
2. WHEN a video Media_DTO item has a non-null `poster_url`, THE Gallery SHALL render the video element with the `poster` attribute set to the `poster_url` value.
3. WHERE a video Media_DTO item has a non-null `poster_url`, THE Gallery SHALL set the video element `preload` attribute to `none`.
4. THE Gallery SHALL render video items without blocking on poster availability.
5. IF a poster fails to load or does not load within a configured timeout, THEN THE Gallery SHALL display the placeholder so every video slot shows a visible element.

### Requirement 13: Backfill of Existing Videos

**User Story:** As an operator, I want a one-time backfill for existing videos without posters, so that previously uploaded videos also receive posters.

#### Acceptance Criteria

1. WHEN the Backfill_Process runs, THE Backfill_Process SHALL enqueue a Poster_Job for each video Media_Row whose `poster_url` is `NULL` and which has no existing Poster_Job.
2. THE Backfill_Process SHALL enqueue Poster_Jobs only for Media_Rows whose `media_type` is `video`, and SHALL NOT enqueue a Poster_Job for any non-video Media_Row.
3. WHEN the Backfill_Process is executed more than once, THE Backfill_Process SHALL create no duplicate Poster_Jobs for a given `media_id`.
4. THE Backfill_Process SHALL leave every existing Media_Row and its `content` value unchanged.

### Requirement 14: Secrets Handling

**User Story:** As a security-conscious operator, I want database and blob credentials kept server-side and out of logs, so that secrets are never exposed to clients or leaked.

#### Acceptance Criteria

1. THE Poster_Worker SHALL read Database_Url and Blob_Token exclusively from environment variables.
2. THE System SHALL NOT expose Database_Url or Blob_Token to any client response.
3. THE System SHALL NOT write the value of Database_Url or Blob_Token to any log output.
4. IF an error is logged during poster processing, THEN THE Poster_Worker SHALL log non-secret context only and omit Database_Url and Blob_Token values.

### Requirement 15: Backward Compatibility

**User Story:** As a user with previously uploaded videos, I want existing videos to keep working, so that no media becomes broken by this feature.

#### Acceptance Criteria

1. WHERE a video Media_Row has a `NULL` `poster_url`, THE Gallery SHALL continue to play that video when the user opens it.
2. THE System SHALL leave existing image handling behavior unchanged.
3. THE System SHALL leave the existing direct-to-Blob upload flow and Media_Row creation behavior unchanged except for adding Poster_Job enqueue for videos.
4. WHEN the Poster_Worker is not running, THE Event_Endpoint SHALL continue to return Media_DTO items with `poster_url` as `null` for videos without posters.

### Requirement 16: Observability

**User Story:** As an operator, I want visibility into poster job processing, so that I can monitor throughput and diagnose failures.

#### Acceptance Criteria

1. WHEN the Poster_Worker claims a Poster_Job, THE Poster_Worker SHALL log the `media_id` and the resulting Job_Status transition without secret values immediately at claim time before processing begins.
2. WHEN a Poster_Job completes with `status` `done`, THE Poster_Worker SHALL log the `media_id` and completion outcome.
3. IF a Poster_Job fails, THEN THE Poster_Worker SHALL log the `media_id`, the current `attempts` count, and a non-secret error description.
4. THE Poster_Job_Table SHALL retain the `attempts` count and latest `updated_at` timestamp for each Poster_Job so processing history is queryable.

### Requirement 17: Invalid or Unprocessable Video Handling

**User Story:** As an operator, I want videos that cannot be processed to fail cleanly, so that one bad video does not stall the queue.

#### Acceptance Criteria

1. IF Ffmpeg cannot extract a frame from a video, THEN THE Poster_Worker SHALL treat the Poster_Job as failed and apply the Retry_Backoff and Max_Attempts rules.
2. IF the video referenced by a Media_Row `content` URL is not retrievable, THEN THE Poster_Worker SHALL treat the Poster_Job as failed and apply the Retry_Backoff and Max_Attempts rules.
3. WHEN a Poster_Job reaches `failed` status, THE Poster_Worker SHALL leave the Media_Row `poster_url` unchanged from its prior value rather than clearing or overwriting it.
4. WHEN one Poster_Job fails, THE Poster_Worker SHALL continue claiming and processing other Poster_Jobs.
