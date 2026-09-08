# Implementation Plan: Upload & Media Architecture

## Overview

This plan implements the new upload/media architecture **additively and incrementally**, following the design's Phase 2 through Phase 8 plan. The core discipline throughout: the legacy `POST /api/event/[event-slug]/media` route and its demo guard, the existing JWT auth, and the current upload behavior remain **fully intact and working** while the new direct-to-Blob path is built alongside. The app must stay functional after every task. Only a late, dedicated task (Phase 8) deprecates/removes the legacy path — and only after the new path is proven on a preview deployment.

Language: **TypeScript** (matches the existing Next.js App Router codebase and the design's concrete interfaces).

Key non-negotiables carried from the design/requirements:
- New routes replicate existing auth + demo checks **verbatim**; `lib/auth.ts` only *extracts* JWT verification without widening permissions (Req 17).
- No migration is written until the **live** Neon `media` columns are confirmed; `schema.sql` is stale (Req 16, Finding 1.9). The migration is additive/nullable → reversible.
- Client confirm is the source of truth; `onUploadCompleted` is reconciliation only and **does not fire on localhost** (integration must run on a preview deployment) (D1, Req 8.4).
- Duplicate protection is enforced by the DB (partial UNIQUE index on `upload_id`) + `ON CONFLICT DO NOTHING` (Req 7, 13.3, 22).
- No `tus`/`uppy`/custom resumable protocol. Canvas-first compression; `browser-image-compression` only as a conditional fallback (Req 1.6, design Dependencies).

Property tests use `fast-check` (added under devDependencies in Phase 8). Property annotations reference design properties P1-P7.

---

## Tasks

- [x] 1. Phase 2 - Verify environment, extract auth, and prepare (reversible) migration

  - [x] 1.1 Verify live `media` columns and `next.config` image remote patterns
    - Query the **live Neon database** (not `schema.sql`) to confirm the actual `media` columns in use (`content`, `type`, `date`, `user_id`, `section_id`, `event_id`, `blurhash`) and whether `upload_id` already exists; record findings as a comment/note. `schema.sql` is stale per Finding 1.9.
    - Inspect `next.config` (locate `next.config.js`/`.mjs`/`.ts`) and confirm the Vercel Blob host is present in `images.remotePatterns`; if missing, add the Blob host pattern (this is a non-structural config change, allowed without live-column verification).
    - Files/components: `next.config.*`, `lib/db.ts` (read-only, reuse pool for the verification query), live Neon DB (read-only inspection).
    - Client vs server: server-only (DB inspection + build config).
    - Dependencies: none (first task).
    - Validation/testing: manual confirmation of column list and remote pattern; no code behavior changes.
    - Rollback: config edit to `images.remotePatterns` is a small additive change, trivially reversible.
    - _Requirements: 16.1, 16.2, 16.3, 15.5_

  - [x] 1.2 Extract JWT verification into `lib/auth.ts` (`verifyRequest`) without widening permissions
    - Create `lib/auth.ts` exporting `AuthedUser` and `verifyRequest(request)` returning `{ok:true,user}` or `{ok:false,response}`.
    - Copy the **existing** verification logic verbatim: read `auth_token` cookie, check `JWT_SECRET` (→ 500 if missing), `jwt.verify` (→ 401 on missing/invalid/expired), map payload `{ userId, email, isAdmin }` to `AuthedUser`. No new permissions, no behavior change.
    - Do NOT yet refactor existing routes to use it (keeps legacy path untouched this task); new routes will consume it.
    - Files/components: `lib/auth.ts` (new), reference `app/utils/jwt.ts` and an existing route (e.g. `app/api/me/route.ts`) for the exact current logic.
    - Client vs server: server-only.
    - Dependencies: none.
    - Validation/testing: covered by unit tests in 7.2; verify build passes.
    - Rollback: new isolated file; removable with no impact on legacy routes.
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 17.1, 17.2, 17.3, 17.4_

  - [x] 1.3 Write the additive, reversible `upload_id` migration (only after 1.1 confirms live columns)
    - Only proceed if 1.1 confirmed the live `media` columns; otherwise HALT and report (Req 16.3).
    - Create a migration in `migrations/` that adds a **nullable** `upload_id UUID` column and a **partial UNIQUE index** `CREATE UNIQUE INDEX media_upload_id_key ON public.media (upload_id) WHERE upload_id IS NOT NULL;`.
    - Nullable + partial index keeps historical rows valid and makes `ON CONFLICT (upload_id) DO NOTHING` the atomic dedupe primitive.
    - Database changes: additive column + partial unique index (no data rewrite).
    - Client vs server: server/DB only.
    - Dependencies: 1.1.
    - Validation/testing: confirm index enforces one row per non-null `upload_id` (exercised by property test P1 in 8.x).
    - Rollback: additive nullable column + index → reversible by dropping the index and column; no existing behavior depends on it yet.
    - _Requirements: 16.4, 13.3, 7.5_

  - [ ] 2. Checkpoint - Phase 2 complete
    - Ensure the build passes, live columns are confirmed, migration is additive/reversible, and the legacy upload path is unchanged and still working. Ask the user if questions arise.

- [x] 3. Phase 3 - `upload-token` handshake route (`handleUpload`)

  - [x] 3.1 Implement `POST /api/event/[event-slug]/media/upload-token` with `handleUpload`, auth, and demo guard
    - Create `app/api/event/[event-slug]/media/upload-token/route.ts` using `@vercel/blob/client` `handleUpload`.
    - Order of checks (demo restriction evaluated **before** issuing any token / upload / mutation / processing, per Req 4.9): `if (isDemoEvent(eventSlug)) return demoGuardResponse();` first → `verifyRequest(request)` → reject `isDemoUser(user.email)` as defense in depth.
    - Parse and validate `clientPayload` `{ uploadId, eventSlug, filename, contentType, size }`: `uploadId` must be UUID; `eventSlug` must match route param. Resolve `event_id` from slug (404 if missing); confirm the user may upload to that event (403 on mismatch).
    - In `onBeforeGenerateToken` return: `allowedContentTypes` (image/* + accepted video types), `maximumSizeInBytes` (100MB, matching current `MAX_FILE_SIZE`), `addRandomSuffix: true`, namespaced `pathname` `events/{eventId}/{uploadId}/{safeName}`, and `tokenPayload` `{ uploadId, userId, eventId }`. `BLOB_READ_WRITE_TOKEN` stays server-side.
    - Add an `onUploadCompleted` stub that will hold reconciliation logic (implemented in Phase 4, task 4.3) — for now it must be demo/validity-safe and create no row on demo/invalid input.
    - Unsupported-type and too-large rejections flow through `allowedContentTypes` / `maximumSizeInBytes` (Req 19.11/19.12 server side).
    - Files/components: `app/api/event/[event-slug]/media/upload-token/route.ts` (new), `lib/auth.ts` (1.2), `lib/demo-guard.ts` (preserve, read-only), `lib/db.ts` (event resolution).
    - Client vs server: server-only.
    - Dependencies: 1.2 (auth), 1.1 (event/DB context).
    - Validation/testing: unit tests in 8.x (auth/demo/authorization/type/size); this is an **additive sibling route** — legacy route untouched.
    - Rollback: new route file is removable with zero impact on legacy path.
    - _Requirements: 1.5, 2.1, 2.2, 2.3, 2.5, 3.1, 3.2, 3.3, 3.4, 3.7, 3.8, 4.1, 4.4, 4.8, 4.9, 5.8, 10.x (constraints only), 19.8, 19.11, 19.12_

  - [ ] 4. Checkpoint - Phase 3 complete
    - Ensure the build passes, the handshake route enforces auth + demo + constraints before any token is minted, and the legacy route still works. Ask the user if questions arise.

- [x] 5. Phase 4 - `confirm` route (idempotent insert + orphan cleanup + reconciliation)

  - [x] 5.1 Implement `POST /api/event/[event-slug]/media/confirm` with idempotent insert
    - Create `app/api/event/[event-slug]/media/confirm/route.ts`.
    - Order: `if (isDemoEvent(eventSlug)) return demoGuardResponse();` → `verifyRequest` → reject `isDemoUser` (defense in depth) → parse/validate `ConfirmUploadBody` (400 on malformed/missing fields; 400 if `uploadId` not a UUID, regardless of other conditions) → resolve event (404) → validate `blobUrl` belongs to the event's Blob prefix (400 on mismatch) → resolve section via existing photo-time logic.
    - Insert keyed by `upload_id` using `ON CONFLICT (upload_id) DO NOTHING` backed by the partial unique index; return the inserted row (201) or the existing row (200) when a row already exists for that `uploadId`. Never insert a duplicate.
    - Files/components: `app/api/event/[event-slug]/media/confirm/route.ts` (new), `lib/auth.ts`, `lib/demo-guard.ts` (preserve), `lib/db.ts`, existing section-resolution query.
    - Client vs server: server-only.
    - Dependencies: 1.2, 1.3 (unique index), 3.1 (pathname prefix convention for the blob-belongs-to-event check).
    - Validation/testing: unit tests (demo/demo-user 403, blob/event mismatch 400, malformed 400, dedupe 200) and property test P1 in Phase 8.
    - Rollback: additive sibling route, removable; does not touch legacy route.
    - _Requirements: 3.5, 3.6, 4.2, 4.5, 4.9, 7.3, 7.4, 7.5, 7.6, 7.9, 8.5, 13.4, 20.1, 20.3, 22.1, 22.2, 22.3_

  - [x] 5.2 Add orphaned-Blob cleanup and no-false-completed handling on DB failure
    - In `confirm`, wrap the insert: on DB failure after a successful Blob upload, perform best-effort `del(blobUrl)`, then return `500` with the generic message "Could not save media" (no server internals). Leave no `media` row for that `uploadId`.
    - Ensure the response never leaks internal details (Req 19.13) and errors are logged server-side only (Req 18.4).
    - Files/components: `confirm/route.ts`, `@vercel/blob` `del`.
    - Client vs server: server-only.
    - Dependencies: 5.1.
    - Validation/testing: unit test simulating DB failure → asserts `del` called + 500 + no row; property P2/P3 in Phase 8.
    - Rollback: internal to the additive route.
    - _Requirements: 8.1, 8.2, 8.3, 19.6, 19.13, 20.2, 21.1, 21.4, 18.3, 18.4_

  - [x] 5.3 Implement `onUploadCompleted` reconciliation in the handshake route
    - Fill in the `onUploadCompleted` handler in `upload-token/route.ts` (stubbed in 3.1): demo-safe (create no row for demo event per Req 4.3, no row if original upload did not succeed per Req 8.6), and idempotently insert the `media` row keyed by `uploadId` **only if still missing** (reuse the same `ON CONFLICT` insert as `confirm`).
    - Note in code comments: this path is **production-only** and does not fire on localhost; it is reconciliation, not the source of truth. Integration proof happens in Phase 8 on a preview deployment.
    - Files/components: `upload-token/route.ts` (`onUploadCompleted`), shared idempotent-insert helper (extract a small helper reused by `confirm` and reconciliation), `lib/db.ts`.
    - Client vs server: server-only (webhook from Vercel Blob).
    - Dependencies: 5.1 (shared insert), 1.3 (unique index).
    - Validation/testing: property P1 (confirm + reconciliation don't double-insert) in Phase 8; integration on preview in Phase 8.
    - Rollback: handler lives inside the additive route.
    - _Requirements: 4.3, 7.8, 8.3, 8.4, 8.6_

  - [ ] 6. Checkpoint - Phase 4 complete
    - Ensure the build passes; confirm idempotency, orphan cleanup, and reconciliation are wired; legacy route still works. Ask the user if questions arise.

- [x] 7. Phase 5 - Client image preprocessing and Blob upload wrapper

  - [x] 7.1 Implement `lib/image-preprocess.ts` (Canvas-based compression)
    - Create `lib/image-preprocess.ts` exporting `preprocessImage(file, opts)` with `PreprocessResult`/`PreprocessOptions`.
    - Behavior: confirm the file is an image by content type first (Req 5.8); skip (return original untouched) for videos, non-images, and images below `minSkipBytes` (~200KB); otherwise draw to a canvas capped at `maxEdge`×`maxEdge` (default 2000) preserving aspect ratio and EXIF orientation (`createImageBitmap(file, { imageOrientation: 'from-image' })`), export via `canvas.toBlob(type, quality)` (default ~0.8). Never enlarge: if output is larger than input, keep the original. Never mutate `file`.
    - Files/components: `lib/image-preprocess.ts` (new), client-only (Canvas API).
    - Client vs server: client-only.
    - Dependencies: none (pure client module).
    - Validation/testing: unit tests (skip rules, max-edge clamp, orientation, don't-enlarge) + property test P6 (byte-identical for video/non-image) in Phase 8.
    - Rollback: standalone module; not yet wired into the store.
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8_

  - [x] 7.2 Implement `blob-upload-client.ts` wrapper over `@vercel/blob/client` `upload()`
    - Create `blob-upload-client.ts` exporting `clientUpload(args)` with `ClientUploadArgs`.
    - Call `upload(pathname, body, { access:'public', handleUploadUrl:'/api/event/{slug}/media/upload-token', clientPayload: JSON.stringify({ uploadId, eventSlug, filename, contentType, size }), multipart: true, contentType, onUploadProgress: ({percentage}) => onProgress(percentage), abortSignal: signal })`.
    - `multipart: true` gives automatic part retry within one session; expose optional `onProgress` and `AbortSignal` for cancel. No `tus`/`uppy`/custom protocol.
    - Files/components: `blob-upload-client.ts` (new), consumes the `upload-token` route (3.1) as `handleUploadUrl`.
    - Client vs server: client-only; server side is the handshake route.
    - Dependencies: 3.1 (handshake route must exist).
    - Validation/testing: exercised via store integration + Phase 8 preview integration; unit-level assertion of `upload()` args if feasible.
    - Rollback: standalone module; not yet wired into the store.
    - _Requirements: 1.1, 1.2, 1.4, 1.6, 11.1, 11.2, 11.3, 12.1, 12.4_

  - [ ] 8. Checkpoint - Phase 5 complete
    - Ensure the build passes and the two client modules compile in isolation; legacy path unaffected. Ask the user if questions arise.

- [x] 9. Phase 6 - IndexedDB queue and upload store refactor

  - [x] 9.1 Implement `lib/upload-queue.ts` (IndexedDB persistence)
    - Create `lib/upload-queue.ts` with `QueueRecord`, `QueueStatus`, and `uploadQueue` (`put`/`patch`/`remove`/`all`) using the native IndexedDB API (single object store keyed by `uploadId`). Persist metadata + intent only — never file bytes; never localStorage.
    - Persist fields `uploadId, eventSlug, filename, contentType, originalSize, processedSize, status, blobUrl, error, updatedAt`. Remove record when a row is confirmed.
    - If IndexedDB is unavailable/fails, degrade gracefully so uploads can still proceed (Req 11.6) — the store must not block on queue errors.
    - Files/components: `lib/upload-queue.ts` (new), client-only.
    - Client vs server: client-only.
    - Dependencies: none.
    - Validation/testing: unit tests (put/patch/remove/all round-trip; IndexedDB-unavailable fallback). 
    - Rollback: standalone module; not yet wired.
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 11.4, 11.6, 18.2_

  - [x] 9.2 Refactor `upload.store.ts` to orchestrate preprocess → handshake → upload → confirm
    - Refactor `app/src/stores/upload.store.ts` to the new `UploadItem`/`UploadStore` shape: statuses `queued|processing|uploading|completed|failed|canceled`; track filename, contentType, originalSize, processedSize, progress, retryCount, error, `abort: AbortController`, mediaResult.
    - `enqueueFiles`: generate `uploadId` (UUID v4) per item, carry it through `clientPayload` → Blob pathname → confirm body. `processOne` orchestration: `uploadQueue.put(queued)` → `processing` (call `preprocessImage`) → `uploading` (call `clientUpload`) → set `blobUrl` in queue → `confirm` → append `Media` to `useEventStore`, remove queue record, mark `completed`.
    - **Completion consistency**: mark `completed` only when BOTH the Blob upload AND the `media` row succeed (Req 20); Blob-only → keep non-completed; on Blob-success/DB-fail keep `failed` + persist record (Req 21.2/21.3).
    - Keep concurrency cap at 3; keep the page interactive; if one item fails, continue others.
    - Files/components: `app/src/stores/upload.store.ts` (refactor), consumes `lib/image-preprocess.ts` (7.1), `blob-upload-client.ts` (7.2), `lib/upload-queue.ts` (9.1); appends to `app/src/stores/event.store.ts`.
    - Client vs server: client orchestration; server is handshake + confirm.
    - Dependencies: 7.1, 7.2, 9.1, 3.1, 5.1.
    - Validation/testing: property P7 (no silent errors) considerations; unit/integration in Phase 8.
    - Rollback: this refactors the store's internals but the legacy server route remains; if needed, the store can still target the legacy route as a fallback until Phase 8 deprecation.
    - _Requirements: 1.3, 7.1, 7.2, 10.1, 10.2, 10.3, 10.7, 10.8, 10.9, 18.1, 20.1, 20.2, 20.3, 20.4, 21.2, 21.3_

  - [x] 9.3 Implement retry and cancel in `upload.store.ts`
    - `retryItem(id)`: for a `failed` item, start a fresh `upload()` **reusing the same `uploadId`** (safe by the unique index) (Req 13.1/13.2). `cancelItem(id)`: abort the in-flight upload via its `AbortController`; send no confirm and create no row for a canceled item (Req 10.6). Distinguish abort from failure in `processOne`.
    - Every failure path sets an error message + user-facing status on the item and records the error on the queue record (no silent failures).
    - Files/components: `app/src/stores/upload.store.ts`.
    - Client vs server: client-only.
    - Dependencies: 9.2.
    - Validation/testing: unit tests for retry-reuses-uploadId and cancel-sends-no-confirm; P7 in Phase 8.
    - Rollback: internal to store.
    - _Requirements: 10.4, 10.5, 10.6, 12.2, 12.3, 13.1, 13.2, 18.1, 19.1, 19.4, 19.5_

  - [x] 9.4 Implement `recoverInterrupted` with the three distinct recovery behaviors
    - `recoverInterrupted(eventSlug)`: read `uploadQueue.all()` on app start and surface interrupted records (never auto-resume/silent re-upload, Req 14.8). Implement the three distinct scenarios as distinct behaviors:
      - Multipart part retry (Req 12): handled inside a single `upload()` by the SDK — no queue action.
      - Network-failure recovery (Req 13): user-triggered fresh `upload()` reusing the same `uploadId`.
      - Reload/close recovery (Req 14): Multipart_Session is lost (no cross-reload byte resume). If a record has `blobUrl` set but status ≠ `completed` → offer **confirm-only** (idempotent by `uploadId`); if no `blobUrl` → offer **safe restart** (new `upload()`, same `uploadId`). Records with status `completed` are removed.
      - Integrity guard (Req 14.9): if more than one `media` row already exists for an `uploadId` when recovery begins, HALT recovery for that item and report an integrity error; the server must NOT auto/silently delete any row.
    - Wire a bootstrap call (e.g. `useEffect(() => useUploadStore.getState().recoverInterrupted(eventSlug), [eventSlug])`) at an appropriate app entry, keeping state isolated and using selector subscriptions.
    - Files/components: `app/src/stores/upload.store.ts`, `lib/upload-queue.ts`, one client component/layout for bootstrap wiring (e.g. `app/[event-slug]/page.tsx` or a client boundary).
    - Client vs server: client-only orchestration; confirm-only hits the server confirm route.
    - Dependencies: 9.1, 9.2, 5.1.
    - Validation/testing: unit tests for confirm-only vs restart branch selection and integrity HALT; P1 in Phase 8.
    - Rollback: internal to store + one bootstrap call site.
    - _Requirements: 6.5, 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 14.8, 14.9, 19.2, 19.3_

  - [x] 9.5 Ensure minimal re-renders via selector-scoped subscriptions
    - Update upload UI consumers (`app/components/media-item-placeholder.tsx`, `masonry.tsx`, any progress readers) to subscribe to a single item's slice (e.g. `useUploadStore(s => s.items.find(i => i.id === id)?.progress ?? 0)`) and batch progress updates (emit only on whole-percent change) so one item's progress does not re-render the whole list.
    - Files/components: `app/components/media-item-placeholder.tsx`, `app/components/masonry.tsx`, `app/src/stores/upload.store.ts` (progress batching).
    - Client vs server: client-only.
    - Dependencies: 9.2.
    - Validation/testing: manual/interaction check that progress updates don't re-render the masonry; keep isolated state.
    - Rollback: presentational subscription changes only.
    - _Requirements: 10.9_

  - [ ] 10. Checkpoint - Phase 6 complete
    - Ensure the build passes; the full client orchestration (preprocess → handshake → upload → confirm), retry, cancel, and recovery work; legacy path still available as fallback. Ask the user if questions arise.

- [x] 11. Phase 7 - Media rendering polish

  - [x] 11.1 Optimize `next/image` usage in `media-item.tsx` and `masonry.tsx`
    - In `masonry.tsx`/`media-item.tsx`: apply `priority` to only the first ~2 gallery images; `loading="lazy"` for the rest. Provide accurate two-column `sizes` (e.g. `"(max-width: 768px) 50vw, 25vw"`). Where both intrinsic dimensions are known set `width`/`height`; otherwise skip intrinsic-dimension optimization for that image. Do NOT blindly replace every `<img>` (videos keep their `<video>`). Confirm the Blob host is present in `next.config` `images.remotePatterns` (from 1.1).
    - Files/components: `app/components/media-item.tsx`, `app/components/masonry.tsx`, `next.config.*` (verify only).
    - Client vs server: client-only rendering.
    - Dependencies: 1.1 (remote patterns).
    - Validation/testing: manual visual check; ensure no layout shift regressions.
    - Rollback: presentational; revert to prior rendering props.
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 11.5_

  - [x] 11.2 Polish BlurHash placeholder rendering (immediate + smooth transition, no regeneration per render)
    - In `blurhash-canvas.tsx`/`media-item.tsx`: show the BlurHash placeholder immediately while `!loaded`, transition smoothly to the sharp image on load, and memoize/guard decoding so the BlurHash is not regenerated on every render (only when `blurhash/width/height` change). Preserve the existing server-side BlurHash generation for images; do not generate image-style BlurHash for videos unless already supported.
    - Files/components: `app/components/blurhash-canvas.tsx`, `app/components/media-item.tsx`. Preserve `lib/blurhash.ts` (server generation) unchanged.
    - Client vs server: client rendering; server BlurHash generation preserved.
    - Dependencies: 11.1 (shared component edits).
    - Validation/testing: manual visual check of immediate placeholder + smooth transition; confirm no re-decode per render.
    - Rollback: presentational.
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 11.5_

  - [ ] 12. Checkpoint - Phase 7 complete
    - Ensure the build passes and rendering polish is correct; legacy path still works. Ask the user if questions arise.

- [ ] 13. Phase 8 - Tests, wiring, audits, legacy deprecation, and build

  - [x]* 13.1 Add `fast-check` to devDependencies and set up the test harness
    - Add `fast-check` under `devDependencies` (property tests only). Confirm the existing test runner config or add the minimal standard setup for the project's ecosystem. Do NOT add `browser-image-compression` here (Canvas-first).
    - Files/components: `package.json`, test config.
    - Dependencies: none (enables all property tests below).
    - _Requirements: (testing infrastructure for P1-P7)_

  - [x]* 13.2 Write unit tests for `verifyRequest`, `insertMediaIdempotent`, `preprocessImage`, and `confirm`
    - `verifyRequest`: valid/expired/missing token, missing secret. `insertMediaIdempotent`: concurrent same-`uploadId` inserts → one row. `preprocessImage`: skip rules, max-edge clamp, orientation, don't-enlarge. `confirm`: demo/demo-user → 403, blob/event mismatch → 400, malformed → 400, DB failure → Blob deleted + 500.
    - Files/components: test files alongside `lib/auth.ts`, `confirm/route.ts`, `lib/image-preprocess.ts`, shared insert helper.
    - Dependencies: 13.1, 1.2, 5.1, 5.2, 7.1.
    - _Requirements: 3.1-3.6, 4.2, 4.5, 5.1-5.8, 7.3, 7.4, 7.9, 8.1, 8.2, 17.2, 19.6_

  - [x]* 13.3 Write property test P1 - no duplicate rows across interleavings
    - **Property P1 (No duplicate rows)**: for arbitrary interleavings of {confirm, reconciliation, restart} over a set of `uploadId`s, row count per `uploadId` <= 1.
    - **Validates: Requirements 7.7, 7.8, 13.3, 22.3**
    - Files/components: property test over the shared idempotent insert + `ON CONFLICT` behavior.
    - Dependencies: 13.1, 5.1, 5.3, 1.3.

  - [x]* 13.4 Write property test P4 - demo immutability across all entry points
    - **Property P4 (Demo immutability)**: for arbitrary route/method across `upload-token`, `confirm`, `onUploadCompleted`, retry, recovery, and legacy `POST .../media` + bulk, a demo event OR demo user always yields 403 and zero Blob token / zero `media` row.
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 19.9**
    - Files/components: property test spanning the new + legacy demo-guarded entry points.
    - Dependencies: 13.1, 3.1, 5.1, 5.3.

  - [x]* 13.5 Write property test P6 - preprocess byte-identical for video/non-image
    - **Property P6 (Preprocess safety)**: for arbitrary video/non-image inputs, `preprocessImage` output bytes equal input bytes.
    - **Validates: Requirements 5.5, 5.6, 5.8**
    - Files/components: property test for `lib/image-preprocess.ts`.
    - Dependencies: 13.1, 7.1.

  - [x]* 13.6 Write property tests P2, P3, P5, P7 where feasible
    - **Property P2 (No orphaned rows)** — every new-path row references a Blob that existed at confirm; a failing confirm deletes its Blob. **Validates: Requirements 8.1, 8.2, 8.5, 21.1, 21.4**
    - **Property P3 (No orphaned Blobs on happy path)** — if `upload()` resolves, a matching row exists or the Blob was deleted. **Validates: Requirements 8.3, 21.1, 21.4**
    - **Property P5 (Token secrecy)** — `BLOB_READ_WRITE_TOKEN` never appears in any client response or bundle. **Validates: Requirements 2.1, 2.3, 2.4, 2.5**
    - **Property P7 (No silent errors)** — every failure path sets an error message + user-facing status; nothing swallowed. **Validates: Requirements 18.1, 18.2, 18.3, 7 (P7)**
    - Files/components: property tests across `confirm`, `upload-token`, store, and a bundle/response assertion for P5.
    - Dependencies: 13.1, 3.1, 5.1, 5.2, 9.2, 9.3.

  - [x]* 13.7 Write integration test on a preview deployment (onUploadCompleted path)
    - Exercise the full path on a **preview deployment** (where `onUploadCompleted` fires — it does NOT on localhost): prove reconciliation works and that `confirm` + webhook do NOT double-insert for the same `uploadId`. Also prove the local path where `confirm` alone creates the row.
    - Files/components: integration test/script targeting a preview URL.
    - Dependencies: 5.1, 5.3, 3.1, 9.2.
    - _Requirements: 8.3, 8.4, 7.8, 20.1_

  - [ ] 13.8 Error-handling matrix coverage and no-silent-errors / debug-logging audit
    - Verify every row of the design's error-handling matrix is handled (Req 19.1-19.13): network disconnect, timeout/sleep/navigation, refresh, Blob failure, part-retry exhaustion, DB failure at confirm, auth expiry, authorization failure, demo restriction, duplicate retry, unsupported type, too large, and generic-message-on-error. Audit that no error is swallowed (Req 18.3) and that no leftover debug `console.log` remains in shipped client/server code (Req 18.5); server errors log details server-side only (Req 18.4).
    - Files/components: all new routes and client modules; grep/audit the touched files.
    - Client vs server: both.
    - Dependencies: 9.3, 5.2.
    - _Requirements: 18.3, 18.4, 18.5, 19.1, 19.2, 19.3, 19.4, 19.5, 19.6, 19.7, 19.8, 19.9, 19.10, 19.11, 19.12, 19.13_

  - [ ] 13.9 Full security audit of every upload entry point
    - Audit `upload-token`, `confirm`, `onUploadCompleted`, and the preserved legacy + bulk routes: JWT verified before any token/row; demo guard first; authorization not weakened vs legacy; `BLOB_READ_WRITE_TOKEN` server-only; blob-belongs-to-event enforced at confirm; content type enforced via `allowedContentTypes` + validated MIME at confirm.
    - Files/components: all upload entry points (new + preserved legacy).
    - Client vs server: server-focused audit.
    - Dependencies: 3.1, 5.1, 5.3.
    - _Requirements: 2.1, 2.3, 2.4, 2.5, 3.1-3.8, 4.1-4.9, 17.1, 17.2, 17.3, 17.4_

  - [ ] 13.10 Deprecate/remove the legacy `POST /api/event/[event-slug]/media` route (ONLY after new path verified)
    - Only after 13.7-13.9 prove the new path on a preview deployment: deprecate or remove the legacy `POST .../media` upload route while preserving its demo guard semantics on all remaining routes. Ensure the bulk route and any non-upload behavior it shared remain intact. Switch the store fully off any legacy fallback.
    - Files/components: `app/api/event/[event-slug]/media/route.ts` (legacy POST), `app/src/stores/upload.store.ts` (remove fallback), verify `media/bulk/route.ts` demo guard unaffected.
    - Client vs server: both.
    - Dependencies: 13.7, 13.8, 13.9, 9.2.
    - Rollback: this is the one intentionally non-additive step; keep it last and gated on verification. If issues arise, restore the legacy route (it remained intact until this task).
    - _Requirements: 4.7, 17.3, 17.4 (legacy parity preserved on remaining routes)_

  - [ ] 13.11 Final build and fix all TS/lint/build errors
    - Run `npm run build` and resolve all TypeScript, lint, and build errors introduced across the feature. Confirm the app builds clean.
    - Files/components: whole project.
    - Dependencies: 13.10.
    - _Requirements: (build integrity for the whole feature)_

  - [ ] 14. Final checkpoint - Ensure all tests pass
    - Ensure all unit + property tests pass, the preview integration is green, the security/error audits are clean, and the build succeeds. Ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional (unit/property/integration tests) and can be skipped for a faster MVP, but P1/P4/P6 directly guard the highest-risk properties (dedupe, demo immutability, preprocess safety) and are strongly recommended.
- Each task references specific requirement clause numbers (not just user stories) for traceability.
- The plan is strictly incremental and additive: the legacy `POST .../media` route + demo guard, existing auth, and current upload behavior stay working after every task; only task 13.10 removes the legacy path, and only after the new path is proven on a preview deployment.
- Database change is additive (nullable `upload_id` + partial unique index) and therefore reversible; it is written only after live-column verification (Req 16).
- `onUploadCompleted` does not fire on localhost — reconciliation is verified on a preview deployment (task 13.7).
- Dependency decisions: add `fast-check` (dev) with the property tests; add `browser-image-compression` only as a conditional fallback if Canvas orientation/quality proves insufficient; never add `tus`/`uppy` or a custom resumable protocol.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "7.1", "9.1"] },
    { "id": 1, "tasks": ["1.3", "3.1"] },
    { "id": 2, "tasks": ["5.1", "7.2"] },
    { "id": 3, "tasks": ["5.2", "5.3"] },
    { "id": 4, "tasks": ["9.2"] },
    { "id": 5, "tasks": ["9.3", "9.4"] },
    { "id": 6, "tasks": ["9.5", "11.1"] },
    { "id": 7, "tasks": ["11.2", "13.1"] },
    { "id": 8, "tasks": ["13.2", "13.3", "13.4", "13.5", "13.6", "13.7"] },
    { "id": 9, "tasks": ["13.8", "13.9"] },
    { "id": 10, "tasks": ["13.10"] },
    { "id": 11, "tasks": ["13.11"] }
  ]
}
```
