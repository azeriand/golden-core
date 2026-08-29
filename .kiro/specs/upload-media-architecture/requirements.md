# Requirements Document

## Introduction

This feature reworks how `golden-core` (a Next.js App Router gallery app) uploads media and loads it back for display. File bytes are moved off the Next.js serverless function: the browser compresses images client-side and uploads directly to Vercel Blob using the official `@vercel/blob/client` `upload()` helper with `multipart: true`. The server's only role in the byte path is an authenticated token handshake (`handleUpload`) that verifies the JWT, enforces demo restrictions, resolves the event, and constrains content type / size / pathname before Vercel Blob issues a short-lived client token. `BLOB_READ_WRITE_TOKEN` never leaves the server. After the browser upload resolves, the client calls a confirm endpoint that creates the `media` row as the reliable primary path; `onUploadCompleted` (production only) acts as an idempotent reconciliation path. An upload is considered completed only when both the Vercel Blob upload has succeeded and the corresponding `media` row has been created or confirmed, and a database UNIQUE constraint on `upload_id` guarantees at most one `media` row per upload so no retry or lost response can produce a duplicate.

The design is additive and reversible. The existing `POST /api/event/[event-slug]/media` route and its demo guard remain in place until the new path is proven, existing authorization checks are preserved verbatim, and no schema migration is written until the live database schema is confirmed. These requirements are derived from and traceable to the approved design document (`design.md`) and its correctness properties P1-P7.

A central, explicit distinction runs through these requirements: three separate recovery/retry scenarios must never be conflated. (1) Retrying failed multipart parts within one upload session is handled automatically by the SDK inside a single `upload()` call. (2) Recovering after a temporary network failure means a fresh `upload()` reusing the same uploadId. (3) Recovering after the browser/tab is closed or refreshed means the in-memory multipart session is lost and there is no cross-reload resume of the in-flight Vercel Blob byte *stream*; recovery is a confirm-only action (when the Blob already exists) or a fresh `upload()` reusing the same uploadId. The queue persists an enqueue-time `date` so confirm-only recovery after a reload can build a valid confirm body without fabricating a date.

**AMENDMENT (Change 3).** To make scenario (3) seamless for the common case, the queue now persists the actual upload *bytes* for **resumable images** (at most a configured `RESUMABLE_MAX_BYTES` cap) in a separate IndexedDB store, with mandatory cleanup on every terminal outcome (confirm success, cancel, dismiss). On reload such an image is **transparently auto-resumed** — a fresh `upload()` reusing the same uploadId, shown as a visible placeholder, requiring no reselect — while videos and oversized images persist only a preview thumbnail and are surfaced with a dismissable warning. Cross-reload resume of the in-flight Vercel Blob multipart byte *stream* itself is still NOT provided; auto-resume is a fresh upload of the persisted bytes under the same uploadId (so idempotency guarantees still hold). This revises the earlier blanket "never persist bytes" decision (Req 6 / design D4).

## Glossary

- **Upload_Token_Handshake**: The server route `POST /api/event/[event-slug]/media/upload-token` implemented with `@vercel/blob/client` `handleUpload`, which authenticates and constrains a client upload before Vercel Blob mints a short-lived client token.
- **Confirm_Endpoint**: The server route `POST /api/event/[event-slug]/media/confirm` that creates the `media` database row after a browser upload resolves.
- **Reconciliation_Callback**: The `onUploadCompleted` handler (production only) that idempotently inserts a `media` row if one is still missing.
- **Blob_Client**: The client wrapper (`blob-upload-client.ts`) over `@vercel/blob/client` `upload()` performing the direct-to-Blob transfer.
- **Image_Preprocessor**: The client module (`lib/image-preprocess.ts`) that compresses images using the Canvas API.
- **Upload_Queue**: The client IndexedDB store (`lib/upload-queue.ts`) persisting pending-upload metadata and intent (not bytes).
- **Upload_Store**: The client Zustand store (`upload.store.ts`) orchestrating preprocess, handshake, upload, confirm, retry, cancel, and recovery.
- **Auth_Verifier**: The extracted server helper (`lib/auth.ts`, `verifyRequest`) that verifies the JWT in the `auth_token` cookie.
- **Demo_Guard**: The existing `lib/demo-guard.ts` behavior (`isDemoEvent`, `isDemoUser`, `demoGuardResponse`) that returns 403 for demo contexts.
- **Upload_Id**: A client-generated UUID v4 correlation identifier that flows from handshake through Blob pathname, confirm body, and a unique database column.
- **Media_Renderer**: The client components (`media-item.tsx`, `masonry.tsx`) that render media using `next/image` and BlurHash placeholders.
- **BLOB_READ_WRITE_TOKEN**: The server-only Vercel Blob credential that must never reach the client.
- **Client_Token**: A short-lived token minted by Vercel Blob for a single client upload.
- **Multipart_Session**: The in-memory state of a single `upload()` call that splits a file into parts; not persisted and not resumable across a page reload.
- **Live_Database**: The running Neon PostgreSQL database whose columns have diverged from `schema.sql` (per audit finding 1.9).

## Requirements

### Requirement 1: Native Vercel Blob Client Uploads

**User Story:** As a developer, I want media bytes uploaded directly to Vercel Blob using the native client SDK, so that large files bypass the Next.js function limits without any custom transport.

#### Acceptance Criteria

1. THE Blob_Client SHALL upload media bytes directly to Vercel Blob using the `@vercel/blob/client` `upload()` helper.
2. THE Blob_Client SHALL invoke `upload()` with `multipart: true` for all client uploads.
3. THE Upload_Store SHALL always report upload progress to the user for every active upload item.
4. THE Blob_Client SHALL support an optional `onUploadProgress` callback and, WHEN a progress callback is supplied, SHALL report upload completion percentage through it.
5. THE Upload_Token_Handshake SHALL be implemented using the `@vercel/blob/client` `handleUpload` function.
6. THE Blob_Client SHALL NOT use `tus-js-client`, `uppy`, or any custom resumable upload protocol.

### Requirement 2: Server-Only Blob Credential Secrecy

**User Story:** As a security engineer, I want the Blob write credential to stay on the server, so that clients can never obtain long-lived write access to Blob storage.

#### Acceptance Criteria

1. THE Upload_Token_Handshake SHALL keep BLOB_READ_WRITE_TOKEN on the server for every request.
2. WHEN the Upload_Token_Handshake authorizes a request successfully, THE Upload_Token_Handshake SHALL return exactly one short-lived Client_Token to the browser.
3. THE server SHALL exclude BLOB_READ_WRITE_TOKEN from every client HTTP response body.
4. THE client bundle SHALL exclude BLOB_READ_WRITE_TOKEN from its shipped output.
5. WHILE performing a client upload, THE Blob_Client SHALL hold only a short-lived Client_Token.

### Requirement 3: Authentication Before Upload Permission

**User Story:** As a security engineer, I want uploads authorized only for verified users, so that no upload permission is granted without a valid session.

#### Acceptance Criteria

1. WHEN the Upload_Token_Handshake receives a request, THE Upload_Token_Handshake SHALL verify the JWT from the `auth_token` cookie via the Auth_Verifier before any Client_Token is minted.
2. IF the JWT is missing or invalid, THEN THE Upload_Token_Handshake SHALL return a 401 response and mint no Client_Token.
3. IF the JWT is expired, THEN THE Upload_Token_Handshake SHALL return a 401 response and mint no Client_Token.
4. IF the JWT_SECRET is not configured, THEN THE Auth_Verifier SHALL return a 500 response and mint no Client_Token.
5. WHEN the Confirm_Endpoint receives a request, THE Confirm_Endpoint SHALL verify the JWT via the Auth_Verifier before creating any `media` row.
6. IF the JWT verification fails at the Confirm_Endpoint, THEN THE Confirm_Endpoint SHALL return a 401 response and create no `media` row.
7. WHEN the Upload_Token_Handshake resolves the target event, THE Upload_Token_Handshake SHALL confirm the authenticated user is permitted to upload to that event before minting a Client_Token.
8. IF the authenticated user is not permitted to upload to the resolved event, THEN THE Upload_Token_Handshake SHALL return a 403 response, mint no Client_Token, and create no `media` row.

### Requirement 4: Demo Protection on Every Upload Entry Point

**User Story:** As a product owner, I want the demo experience to remain immutable, so that demo events and the demo user can never create or alter stored media.

#### Acceptance Criteria

1. WHEN the Upload_Token_Handshake receives a request for a demo event, THE Upload_Token_Handshake SHALL return a 403 response, mint no Client_Token, and create no `media` row.
2. WHEN the Confirm_Endpoint receives a request for a demo event, THE Confirm_Endpoint SHALL return a 403 response and create no `media` row.
3. WHEN the Reconciliation_Callback processes an event that is a demo event, THE Reconciliation_Callback SHALL create no `media` row.
4. WHERE a request originates from the demo user, THE Upload_Token_Handshake SHALL return a 403 response, mint no Client_Token, and create no `media` row.
5. WHERE a request originates from the demo user, THE Confirm_Endpoint SHALL return a 403 response and create no `media` row.
6. WHEN a retry or queue-recovery action targets a demo event or originates from the demo user, THE Upload_Store SHALL be denied at the server entry point with a 403 response and create no `media` row.
7. WHEN the existing `POST /api/event/[event-slug]/media` route or the bulk media route receives a request for a demo event, THE server SHALL return a 403 response via `demoGuardResponse()` and create no `media` row.
8. THE Demo_Guard SHALL replicate the existing `isDemoEvent`, `isDemoUser`, and `demoGuardResponse` behavior on the new entry points without modification.
9. WHEN evaluating a demo restriction on any new entry point, THE server SHALL evaluate the demo restriction before issuing any Client_Token, performing any Blob upload, performing any database mutation, creating any media, or performing any business processing; THE server MAY perform the minimal request parsing and authentication necessary to identify the event and user before that evaluation.

### Requirement 5: Client-Side Image Compression

**User Story:** As a user, I want images compressed before upload, so that uploads are faster and use less bandwidth without visibly degrading quality.

#### Acceptance Criteria

1. WHEN the Image_Preprocessor processes an image larger than the configured skip threshold, THE Image_Preprocessor SHALL constrain the output so both dimensions are at most 2000 pixels.
2. WHEN the Image_Preprocessor compresses an image, THE Image_Preprocessor SHALL encode the output at approximately 0.8 quality.
3. WHEN the Image_Preprocessor resizes an image, THE Image_Preprocessor SHALL preserve the EXIF orientation in the output.
4. WHERE an input image is smaller than the configured skip threshold, THE Image_Preprocessor SHALL return the original file unchanged.
5. WHERE an input file is a video, THE Image_Preprocessor SHALL return the original file unchanged.
6. WHERE an input file is not an image, THE Image_Preprocessor SHALL return the original file unchanged.
7. IF compression would produce output larger than the input, THEN THE Image_Preprocessor SHALL return the original file unchanged.
8. WHEN the Image_Preprocessor validates an input file, THE Image_Preprocessor SHALL confirm the file is an image by content type before applying any compression so that a video is never processed through the compression pipeline.

### Requirement 6: IndexedDB Persistence for Pending Uploads

**User Story:** As a user, I want my pending uploads remembered across crashes and reloads, so that I can recover interrupted uploads rather than losing track of them.

#### Acceptance Criteria

1. WHEN an upload item is enqueued, THE Upload_Queue SHALL persist a record in IndexedDB keyed by Upload_Id.
2. THE Upload_Queue metadata record SHALL persist upload metadata and intent and SHALL NOT contain the file bytes. (AMENDED — see 6.7: file bytes for resumable images are persisted in a SEPARATE object store, never on the metadata record.)
3. THE Upload_Queue SHALL NOT use localStorage for pending-upload persistence.
4. WHEN an upload item's state changes, THE Upload_Queue SHALL persist the record fields `uploadId`, `eventSlug`, `filename`, `contentType`, `originalSize`, `processedSize`, `status`, `blobUrl`, `error`, `date`, and `updatedAt`, and MAY persist the optional recovery-UX fields `blurhash`, `kind`, `hasBytes`, `oversized`, and `thumbnailDataUrl` (all back-compatible; legacy records lacking them behave as before).
5. WHEN a `media` row is confirmed for an upload item, THE Upload_Queue SHALL remove the corresponding metadata record AND its persisted file bytes (if any).
6. WHEN an upload item is enqueued, THE Upload_Queue SHALL persist `date` as the ISO-8601 timestamp captured at enqueue time (the same value the Confirm_Endpoint receives on the same-session path), and THE Upload_Queue SHALL NOT modify `date` on later state transitions. THE persisted `date` represents the upload intent time and is distinct from `updatedAt` (the last-updated timestamp).

> **AMENDMENT (Change 3 — byte-persisted transparent auto-resume).** This deliberately revises the earlier "never persist bytes" decision (originally 6.2 / design D4) for **resumable images only**, with strict cleanup. The following criteria supersede the blanket no-bytes rule while preserving no-silent-errors (Req 18) and idempotency (Req 7).

7. WHEN an upload item is enqueued AND it is an image whose size is at most `RESUMABLE_MAX_BYTES` (a configured cap, default 20 MB), THE Upload_Queue SHALL persist the actual upload bytes in a SEPARATE IndexedDB object store keyed by Upload_Id, so the item is eligible for transparent cross-reload auto-resume. THE Upload_Queue SHALL NOT persist those bytes on the metadata record.
8. WHEN an upload item is enqueued AND it is a video OR an image larger than `RESUMABLE_MAX_BYTES`, THE Upload_Queue SHALL NOT persist the file bytes; instead THE Upload_Store SHALL best-effort persist a small preview thumbnail (a downscaled data URL) so recovery can show the thumbnail with a dismissable warning.
9. WHEN an upload item reaches any terminal outcome (confirm success, cancel, or dismiss), THE Upload_Queue SHALL delete the persisted bytes for that Upload_Id, leaving no orphaned bytes.
10. IF IndexedDB (or the bytes object store) is unavailable, THEN byte persistence SHALL be a best-effort no-op and THE Upload_Store SHALL still allow the upload to proceed (Req 11.6); cross-reload auto-resume is simply not offered in that case.
11. WHEN the application starts and an interrupted record has NO `blobUrl` but HAS persisted bytes (a resumable image), THE Upload_Store SHALL transparently AUTO-RESUME it by recreating a VISIBLE uploading placeholder for the SAME Upload_Id and driving it through the same attempt-guarded upload machinery (subject to the concurrency cap), reusing the SAME Upload_Id and requiring no reselect. THE Upload_Store SHALL NOT mint a new Upload_Id and SHALL NOT silently re-upload without surfacing a visible placeholder.
12. WHEN the application starts and an interrupted record has NO `blobUrl` and NO persisted bytes (a video or an oversized image), THE Upload_Store SHALL surface an inert item showing the persisted thumbnail plus a dismissable warning, and SHALL take no automatic action.

### Requirement 7: Idempotent Media Creation Using Upload Id

**User Story:** As a data owner, I want media creation keyed by a stable correlation id, so that retries and reconciliation never create duplicate media rows.

#### Acceptance Criteria

1. THE Upload_Store SHALL generate an Upload_Id as a UUID v4 for each upload item.
2. THE Upload_Store SHALL carry the Upload_Id through the handshake `clientPayload`, the Blob pathname, and the confirm request body.
3. WHEN the Confirm_Endpoint receives a request, THE Confirm_Endpoint SHALL validate that the supplied Upload_Id is a UUID.
4. IF the supplied Upload_Id is not a valid UUID, THEN THE Confirm_Endpoint SHALL return a 400 response and create no `media` row, regardless of any other condition.
9. IF the confirm request body is malformed or missing required fields while the Upload_Id is valid, THEN THE Confirm_Endpoint SHALL return a 400 response and create no `media` row.
5. WHEN the Confirm_Endpoint inserts a `media` row, THE Confirm_Endpoint SHALL perform an insert keyed by Upload_Id using `ON CONFLICT (upload_id) DO NOTHING` backed by the database UNIQUE constraint on `upload_id`.
6. WHEN a `media` row already exists for the supplied Upload_Id, THE Confirm_Endpoint SHALL return the existing row with a 200 response and create no additional row.
10. WHEN the Confirm_Endpoint returns a created (201) or existing (200) row, THE response body SHALL be shaped as the Media DTO the gallery consumes — `{ media_id, user_id, content, likes, liked, date, type, section_id, blurhash, username }` — mirroring exactly what `GET /api/event/[event-slug]` emits per media, so the Upload_Store can append it to the event store and render it live without a refresh. (Change 1: the raw `INSERT ... RETURNING *` row lacks `username`/`likes`/`liked`; the endpoint resolves them via one query.)
7. FOR ALL Upload_Ids, the count of `media` rows where `upload_id` equals that Upload_Id SHALL be at most one, regardless of retries, reload restarts, or the Reconciliation_Callback firing after confirm.
8. WHEN the Reconciliation_Callback and the Confirm_Endpoint both process the same Upload_Id, THE server SHALL create at most one `media` row for that Upload_Id.

### Requirement 8: Orphaned Blob Cleanup and Reconciliation

**User Story:** As a data owner, I want failed database inserts to clean up their Blobs and missing rows to be reconciled, so that storage never accumulates orphaned Blobs or rows.

#### Acceptance Criteria

1. IF the `media` row insert fails after a successful Blob upload, THEN THE Confirm_Endpoint SHALL perform a best-effort `del(blobUrl)` on the uploaded Blob.
2. IF the `media` row insert fails after a successful Blob upload, THEN THE Confirm_Endpoint SHALL return a 500 response and leave no `media` row for that Upload_Id.
3. WHEN the Blob upload resolves, THE server SHALL ensure that either a matching `media` row exists via the Confirm_Endpoint or the Reconciliation_Callback, or the Blob was deleted after a database failure.
4. WHILE running in production, IF the Reconciliation_Callback fires and no `media` row exists for the Upload_Id, THEN THE Reconciliation_Callback SHALL insert the `media` row idempotently keyed by Upload_Id.
5. WHEN the Confirm_Endpoint creates a `media` row, THE `content` value SHALL reference a Blob that existed at confirm time.
6. IF the original Blob upload did not succeed, THEN THE Reconciliation_Callback SHALL create no `media` row.

### Requirement 9: BlurHash Placeholders

**User Story:** As a user, I want a soft blurred placeholder to appear immediately, so that images load smoothly without layout jank.

#### Acceptance Criteria

1. THE server SHALL preserve the existing correct BlurHash generation for images (legacy path).
2. WHEN a media image has not finished loading, THE Media_Renderer SHALL display a blurred BlurHash placeholder immediately.
3. WHEN a media image finishes loading, THE Media_Renderer SHALL transition smoothly from the blurred placeholder to the sharp image.
4. THE Media_Renderer SHALL decode the BlurHash placeholder without regenerating it on every render.
5. WHEN the Image_Preprocessor processes an image (new direct-to-Blob path), THE Image_Preprocessor SHALL compute a client-side BlurHash from the same decoded pixels and return it on the preprocess result, and THE Upload_Store SHALL send it in the Confirm body so the created `media` row carries a BlurHash (and so does confirm-only recovery / auto-resume). (Change 2)
6. THE client-side BlurHash generation SHALL be NON-BLOCKING: IF generation fails for any reason, THEN the result SHALL be `null` and the upload SHALL proceed normally; BlurHash generation SHALL NEVER throw. Videos, non-images, and skipped images SHALL yield `null`.

### Requirement 10: Upload Progress, Retry, and Cancellation

**User Story:** As a user, I want to see per-file upload progress with retry and cancel controls, so that I can manage multiple uploads and recover from individual failures.

#### Acceptance Criteria

1. WHILE an upload item is active, THE Upload_Store SHALL track its filename, content type, original size, progress percentage, and status.
2. WHERE an upload item is an image, THE Upload_Store SHALL track its processed size.
3. THE Upload_Store SHALL represent each upload item's status as one of `uploading`, `processing`, `completed`, or `failed`.
4. WHEN an upload item's status is `failed`, THE Upload_Store SHALL allow the user to retry that item.
5. WHILE an upload item is in progress and cancellation is possible, THE Upload_Store SHALL allow the user to cancel that item by aborting the in-flight upload.
6. WHEN a user cancels an in-flight upload, THE Upload_Store SHALL send no confirm request and create no `media` row for that item.
7. WHEN multiple files are enqueued, THE Upload_Store SHALL process them concurrently up to a limit of three active uploads.
8. IF one upload item fails, THEN THE Upload_Store SHALL continue processing the remaining upload items.
9. WHILE uploads are in progress, THE Upload_Store SHALL keep the page interactive and non-blocking.

### Requirement 11: Video Uploads Without Image Preprocessing

**User Story:** As a user, I want to upload videos directly, so that videos transfer reliably without being processed as images.

#### Acceptance Criteria

1. WHEN a video is uploaded, THE Blob_Client SHALL upload it directly to Vercel Blob using `upload()` with `multipart: true`.
2. WHILE a video uploads, THE Upload_Store SHALL report upload progress for that video.
3. WHILE a video uploads, THE Blob_Client SHALL rely on the SDK to retry failed multipart parts within the same upload session.
4. WHEN a video is enqueued, THE Upload_Queue SHALL persist its state in IndexedDB.
5. THE Media_Renderer SHALL NOT generate image-style BlurHash for a video unless BlurHash for that video is already supported.
6. IF IndexedDB persistence is unavailable or fails, THEN THE Upload_Store SHALL allow the upload to proceed.

### Requirement 12: Retrying Multipart Parts Within a Single Upload Session

**User Story:** As a user, I want individual failed file parts retried automatically during an upload, so that transient part failures do not fail the whole upload.

#### Acceptance Criteria

1. WHILE a single `upload()` call is in progress, THE Blob_Client SHALL rely on the SDK `multipart: true` behavior to automatically retry failed parts within that Multipart_Session.
2. WHILE parts are being retried within a Multipart_Session, THE Upload_Store SHALL keep the upload item in the `uploading` state.
3. IF all automatic part retries within a Multipart_Session are exhausted, THEN THE Blob_Client SHALL reject the `upload()` call and THE Upload_Store SHALL mark the item `failed` with an error message.
4. THE Blob_Client SHALL NOT implement any custom part-level retry protocol outside the SDK `multipart` behavior.

### Requirement 13: Recovery After Temporary Network Failure

**User Story:** As a user, I want to restart an upload that failed due to a network drop, so that I can complete it without creating a duplicate.

#### Acceptance Criteria

1. WHEN a network failure causes the `upload()` call to reject, THE Upload_Store SHALL mark the upload item `failed` and persist the record in the Upload_Queue.
2. WHEN a user retries an upload item that failed due to a network failure, THE Upload_Store SHALL start a fresh `upload()` call reusing the same Upload_Id.
3. THE Live_Database SHALL enforce at most one `media` row per Upload_Id via a UNIQUE constraint on `upload_id`, regardless of whether a prior client attempt was marked failed, completed, interrupted, or in an unknown state.
4. IF a client response for a successful media creation is lost and the client retries with the same Upload_Id, THEN THE server SHALL return or reuse the existing `media` row and SHALL create no additional row.

### Requirement 14: Recovery After Browser or Tab Close or Refresh

**User Story:** As a user, I want interrupted uploads surfaced after a reload, so that I can safely restart or confirm them, understanding that a byte stream cannot resume across a reload.

#### Acceptance Criteria

1. THE server SHALL NOT provide cross-reload resume of a Vercel Blob byte stream.
2. WHEN the browser or tab is closed or refreshed during an upload, THE Multipart_Session SHALL be treated as lost.
3. WHEN the application starts, THE Upload_Store SHALL read interrupted records from the Upload_Queue and surface them to the user rather than resuming a byte stream.
4. WHERE an interrupted record has a `blobUrl` set (and a persisted `date`) but status is not `completed`, THE Upload_Store SHALL perform a silent confirm-only recovery that calls the Confirm_Endpoint idempotently by Upload_Id, building the confirm body from the persisted record metadata (`uploadId`, `blobUrl`, `filename`, `contentType`, `originalSize`, `processedSize`, `eventSlug`, `blurhash`) and the persisted enqueue-time `date`. On success it appends the returned Media and removes the record; on failure it surfaces the record as a preview + tap-to-retry item (never a silent drop, never a success by the Blob alone). (AMENDED, Change 3: this is now performed automatically rather than merely "offered".)
5. WHERE an interrupted record has no `blobUrl` set: IF it is a resumable image with persisted bytes, THE Upload_Store SHALL TRANSPARENTLY AUTO-RESUME it as a visible placeholder reusing the same Upload_Id (see 6.11); OTHERWISE (video / oversized image, no bytes) THE Upload_Store SHALL surface an inert item with its persisted thumbnail and a dismissable warning (see 6.12). In all cases the Upload_Id is reused and never minted anew. (AMENDED, Change 3: byte-persisted images auto-resume without a reselect; only bytes-less records require user action.)
6. WHEN an interrupted upload is restarted or confirmed during recovery, THE server SHALL create at most one `media` row for that Upload_Id and no orphaned `media` row.
9. IF more than one `media` row already exists for an Upload_Id when recovery begins, THEN THE Upload_Store SHALL halt recovery for that item and report an integrity error to the user, and THE server SHALL NOT automatically or silently delete any `media` row.
7. WHEN the application starts and a queue record has status `completed`, THE Upload_Store SHALL remove that record from the Upload_Queue.
8. THE Upload_Store SHALL NOT silently re-upload an interrupted item without surfacing it. (AMENDED, Change 3: transparent auto-resume of a byte-persisted image IS permitted, but it MUST be VISIBLE — a progress placeholder is shown for the reused Upload_Id — and it goes through the same attempt-guarded machinery under the concurrency cap; it is never a hidden background re-upload, and it never mints a new Upload_Id.)
10. WHEN performing confirm-only recovery, THE Upload_Store SHALL use the persisted enqueue-time `date` from the queue record as the `date` in the Confirm body, and SHALL NOT fabricate a date (e.g. the current time) nor use `updatedAt` as the media date.
11. IF a recoverable record with a `blobUrl` has no persisted `date` (e.g. a legacy record written before `date` was persisted), THEN THE Upload_Store SHALL NOT auto-execute confirm-only recovery for that record and SHALL surface it to the user rather than fabricating a date.

### Requirement 15: next/image Optimization

**User Story:** As a user, I want the gallery to load quickly, so that the first images appear promptly while the rest load lazily without layout shift.

#### Acceptance Criteria

1. THE Media_Renderer SHALL apply `priority` loading to only the first approximately two gallery images.
2. THE Media_Renderer SHALL apply lazy loading to all gallery images other than the first approximately two.
3. THE Media_Renderer SHALL provide accurate `sizes` values that reflect the two-column layout.
4. WHERE both intrinsic dimensions of a media image are known, THE Media_Renderer SHALL set both the intrinsic width and height; otherwise THE Media_Renderer SHALL skip intrinsic-dimension optimization for that image.
5. THE server SHALL confirm the Vercel Blob host is present in `next.config` `images.remotePatterns` before relying on `next/image` for Blob-hosted media.
6. THE Media_Renderer SHALL NOT replace every existing `<img>` element indiscriminately.

### Requirement 16: Live Database Schema Verification Before Migration

**User Story:** As a developer, I want the live database schema confirmed before any migration, so that migrations match reality rather than the stale `schema.sql`.

#### Acceptance Criteria

1. WHEN a database change is planned, THE developer SHALL verify the actual columns against the Live_Database rather than `schema.sql`.
2. THE developer SHALL treat `schema.sql` as stale per audit finding 1.9 when planning any migration.
3. IF the live `media` columns have not been confirmed, THEN THE developer SHALL NOT write the `upload_id` column and unique index migration.
5. WHERE a database change is non-structural and does not depend on schema accuracy, THE developer MAY apply it without live-column verification.
4. WHEN the live columns are confirmed, THE migration SHALL add a nullable `upload_id` UUID column and a UNIQUE constraint on `upload_id` that enforces at most one `media` row per non-null Upload_Id, where a partial unique index on `upload_id` for non-null values satisfies this UNIQUE-constraint intent.

### Requirement 17: No Regression in Existing Authentication and Demo Flow

**User Story:** As a maintainer, I want the existing auth and demo behavior preserved, so that the new upload path introduces no security regression.

#### Acceptance Criteria

1. THE new work SHALL NOT modify the existing authentication and demo session flow.
2. THE Auth_Verifier SHALL extract the existing JWT verification logic without widening permissions beyond current behavior.
3. THE new routes SHALL preserve the existing authorization checks verbatim.
4. WHEN an existing authorization check applies to a media operation, THE new routes SHALL enforce the same check as the legacy route.

### Requirement 18: No Silent Errors

**User Story:** As a user, I want every failure surfaced with a clear message, so that I always know when an upload did not succeed.

#### Acceptance Criteria

1. WHEN an upload item fails on any path, THE Upload_Store SHALL set an error message on the item and set a user-facing status.
2. WHEN an upload item fails, THE Upload_Queue SHALL record the error message on the corresponding record.
3. THE server SHALL NOT swallow errors on any upload-related failure path.
4. WHEN a server error occurs, THE server SHALL both return a generic user-facing message and log the internal details on the server only; IF either action fails, THEN THE error handling SHALL be treated as failed.
5. THE shipped client and server code SHALL NOT contain leftover debug logging.

### Requirement 19: Error Handling Matrix

**User Story:** As a user, I want each upload failure scenario handled with a useful message and no leaked internals, so that failures are understandable and recoverable.

#### Acceptance Criteria

1. IF the network disconnects mid-upload, THEN THE Upload_Store SHALL mark the item `failed`, persist the queue record, and allow retry via a new `upload()` with the same Upload_Id.
2. IF an in-flight upload times out, the tab sleeps, or the user navigates away, THEN THE Upload_Queue SHALL leave the record in the `uploading` state and THE Upload_Store SHALL surface it on the next application start.
3. IF the page is refreshed during an upload, THEN THE Upload_Store SHALL surface the record for restart or confirm-only recovery and SHALL create no duplicate `media` row.
4. IF the Blob upload fails, THEN THE Upload_Store SHALL mark the item `failed` with a message, send no confirm request, and create no `media` row.
5. IF all multipart part retries are exhausted, THEN THE Blob_Client SHALL surface the failure to the Upload_Store as a failed upload.
6. IF the database insert fails at confirm, THEN THE Confirm_Endpoint SHALL perform a best-effort Blob delete and return a 500 response with the message "Could not save media" and no server internals.
7. IF authentication has expired, THEN THE server SHALL return a 401 response and THE Upload_Store SHALL mark the item `failed` with a clear re-authentication message.
8. IF authorization fails due to an event or user mismatch, THEN THE server SHALL return a 403 response, mint no Client_Token, and create no `media` row.
9. IF a request is subject to a demo restriction, THEN THE server SHALL return a 403 response via `demoGuardResponse()`, mint no Client_Token, and create no `media` row.
10. IF the same Upload_Id reaches the Confirm_Endpoint twice, THEN THE Confirm_Endpoint SHALL return the existing row with a 200 response and create no duplicate `media` row.
11. IF an unsupported file type is submitted, THEN THE Upload_Token_Handshake SHALL reject the request via `allowedContentTypes` and THE Upload_Store SHALL display the message "Only images and videos".
12. IF a file exceeds the maximum size, THEN THE Upload_Token_Handshake SHALL reject the request via `maximumSizeInBytes` and THE Upload_Store SHALL display a size-limit message.
13. WHEN the server returns any error response, THE server SHALL exclude server internal details from the response.

### Requirement 20: Upload Completion Consistency

**User Story:** As a user, I want an upload marked complete only when it is truly stored, so that a `completed` status always reflects durable media.

#### Acceptance Criteria

1. THE Upload_Store SHALL NOT mark an upload item `completed` until the Vercel Blob upload has successfully completed AND the corresponding `media` row has been successfully created or confirmed.
2. WHILE the Blob upload has completed but the `media` row has not yet been created or confirmed, THE Upload_Store SHALL keep the item in a non-`completed` state.
3. WHEN both the Blob upload and the `media` row creation or confirmation have succeeded, THE Upload_Store SHALL mark the item `completed`.
4. THE Upload_Store SHALL NOT present a `completed` state to the user based on the Blob upload alone.

### Requirement 21: Blob-Succeeds-Database-Fails Handling

**User Story:** As a data owner, I want a failed database insert after a successful Blob upload handled safely, so that storage stays consistent and the user is never misled.

#### Acceptance Criteria

1. IF the Blob upload succeeds but the `media` row insert fails, THEN THE server SHALL either safely reconcile the existing Blob into a `media` row idempotently by Upload_Id OR safely clean up the Blob via a best-effort `del(blobUrl)`.
2. IF the Blob upload succeeds but the `media` row insert fails, THEN THE Upload_Store SHALL NOT mark the item `completed`.
3. IF the Blob upload succeeds but the `media` row insert fails, THEN THE Upload_Store SHALL mark the item `failed` with a user-facing message and persist the queue record for retry or confirm-only recovery.
4. THE server SHALL NOT leave an orphaned Blob without either a corresponding `media` row or a completed cleanup.

### Requirement 22: Lost Final Response Handling

**User Story:** As a user, I want a retry after a lost success response to be safe, so that a dropped response never creates a duplicate media record.

#### Acceptance Criteria

1. IF the Blob upload and `media` row creation both succeed but the client does not receive the final response, THEN a retry with the same Upload_Id SHALL return or reuse the existing `media` row.
2. WHEN the Confirm_Endpoint receives a retry with an Upload_Id that already has a `media` row, THE Confirm_Endpoint SHALL respond with the existing row and SHALL create no additional row.
3. FOR ALL Upload_Ids, a lost final response followed by any number of retries SHALL result in exactly one `media` row for that Upload_Id.
