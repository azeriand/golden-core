# Upload & Media Architecture — Implementation Audit (READ-ONLY)

Audit of the `upload-media-architecture` spec against the actual code in golden-core. No code, DB, migrations, config, or task status were modified. Neon was not queried (Task 1.1 findings in design.md were trusted). Static checks were read-only (`tsc --noEmit`, `eslint`, `git status/diff`, greps).

## A) Executive Summary

The feature is in strong shape through Phase 6. The server byte-path (auth extraction, `upload-token` handshake, idempotent `confirm` with orphan-Blob cleanup) and the full client orchestration (preprocess, direct-to-Blob upload, IndexedDB queue, retry/cancel/recovery in the store) are implemented and satisfy their requirements. `tsc --noEmit` passes clean; eslint is clean except one benign `_eventSlug` unused-arg warning; no secret leaks and no debug `console.log` in the new client paths.

The one genuine **server gap** is Task 5.3 / Req 8.4: `onUploadCompleted` in the handshake route is still an explicit no-op stub, so production reconciliation is not implemented. The remaining work is Phase 7 rendering polish (11.1 `next/image` priority/sizes, 11.2 BlurHash polish — not started), Task 9.5 selector-scoped re-render tuning (not done — masonry subscribes to the whole `items` array), one UI gap (`cancelItem` exists in the store but is wired into no component — Req 10.5), and all of Phase 8 (tests, audits, legacy removal). Task 5.2's behavior is fully folded into the Task 5.1 confirm route, so 5.2 is satisfied-by-other and should be marked complete or merged.

Nothing found blocks the local-dev path from working; the production reconciliation gap and the missing tests are what stand between the current state and production-ready.

## B) Task-by-Task State

| Task | Status | Evidence | Note |
|---|---|---|---|
| 1.1 Verify live columns + remotePatterns | COMPLETE | `next.config.ts` has `*.public.blob.vercel-storage.com`; design.md records live-column finding | Blob host present; DB finding trusted per instructions |
| 1.2 Extract `verifyRequest` | COMPLETE | `lib/auth.ts` | Verbatim extraction; 401/500 paths; no permission widening |
| 1.3 `upload_id` migration | COMPLETE | `migrations/002_add_upload_id_column.sql` | Nullable UUID + partial unique index `media_upload_id_key`; matches design DDL |
| 2. Checkpoint P2 | CHECKPOINT | — | Build passes; migration additive/reversible |
| 3.1 `upload-token` handshake | COMPLETE | `app/api/event/[event-slug]/media/upload-token/route.ts` | Auth+demo+event+payload+pathname validation; `onUploadCompleted` is a stub (by design at this task) |
| 4. Checkpoint P3 | CHECKPOINT | — | Handshake enforces before minting |
| 5.1 `confirm` idempotent insert | COMPLETE | `confirm/route.ts` | `ON CONFLICT (upload_id) DO NOTHING`, 201/200, blob-belongs-to-event, `head` existence check |
| 5.2 Orphan-Blob cleanup + no-false-completed | PARTIAL-BY-OTHER (satisfied) | `confirm/route.ts` catch block: `del(blobUrl)` best-effort + generic 500 | Behavior folded into 5.1; should be marked complete/merged in tasks.md |
| 5.3 `onUploadCompleted` reconciliation | STILL-REQUIRED | `upload-token/route.ts` `onUploadCompleted` returns `void` (explicit stub) | **Main server gap** (Req 8.4). See Gap G1 |
| 6. Checkpoint P4 | CHECKPOINT | — | Idempotency+cleanup wired; reconciliation NOT wired |
| 7.1 `image-preprocess.ts` | COMPLETE | `lib/image-preprocess.ts` | Skip rules, maxEdge clamp, EXIF orientation, don't-enlarge, graceful degrade |
| 7.2 `blob-upload-client.ts` | COMPLETE | `lib/blob-upload-client.ts` | `@vercel/blob/client` `upload()`, multipart, progress, abort; shares `upload-path.ts` |
| 8. Checkpoint P5 | CHECKPOINT | — | Modules compile in isolation |
| 9.1 `upload-queue.ts` (IndexedDB) | COMPLETE | `lib/upload-queue.ts` | Keyed by uploadId, metadata-only, graceful degrade, immutable `date` in patch |
| 9.2 Store orchestration refactor | COMPLETE | `app/src/stores/upload.store.ts` | preprocess→handshake→upload→confirm; confirm-gated completion; concurrency cap 3 |
| 9.3 Retry + cancel | COMPLETE | store `retryItem`/`cancelItem` + attempt-token guard | Retry reuses uploadId; cancel sends no confirm. cancel not exposed in UI (see 9.5/Req 10.5) |
| 9.4 `recoverInterrupted` | COMPLETE | store `recoverInterrupted` + bootstrap in `app/[event-slug]/page.tsx` | Three behaviors, confirm-only using persisted date, legacy date-less surfaced, integrity note |
| 9.5 Selector-scoped re-renders | STILL-REQUIRED | `masonry.tsx:14` subscribes to `state => state.items` (whole array) | No per-item slice subscription; progress batching exists in store (`setProgress` whole-percent) |
| 10. Checkpoint P6 | CHECKPOINT | — | Orchestration/retry/cancel/recovery work |
| 11.1 `next/image` priority/sizes | STILL-REQUIRED | `media-item.tsx` has no `priority`; `sizes="50vw"` only; `loading="lazy"` on all | Phase 7 not started |
| 11.2 BlurHash polish | STILL-REQUIRED | `blurhash-canvas.tsx` re-decodes on `[blurhash,width,height]`; no memo guard beyond deps | Immediate placeholder + transition already exist (pre-existing); no-regen tuning not done |
| 12. Checkpoint P7 | CHECKPOINT | — | Not reached |
| 13.1 fast-check + harness | STILL-REQUIRED | `package.json` has no `fast-check`, no test runner | No test framework at all |
| 13.2 Unit tests | STILL-REQUIRED | no test files found | — |
| 13.3 Property P1 | STILL-REQUIRED | — | — |
| 13.4 Property P4 | STILL-REQUIRED | — | — |
| 13.5 Property P6 | STILL-REQUIRED | — | — |
| 13.6 Properties P2/P3/P5/P7 | STILL-REQUIRED | — | — |
| 13.7 Preview integration | STILL-REQUIRED | — | Requires preview deploy + 5.3 |
| 13.8 Error-matrix + no-debug-log audit | STILL-REQUIRED (mostly satisfiable now) | no `console.log` in new paths (verified) | Formal audit task not executed |
| 13.9 Security audit | STILL-REQUIRED | — | Spot checks in this report are clean; formal task not run |
| 13.10 Legacy route removal | STILL-REQUIRED | legacy `media/route.ts` + `upload-xhr.ts` still present (intended) | Store no longer calls legacy path; `upload-xhr.ts` now unreferenced |
| 13.11 Final build | STILL-REQUIRED | not run (production build excluded from this audit) | `tsc --noEmit` passes |
| 14. Final checkpoint | CHECKPOINT | — | Not reached |

## C) Requirements Coverage

- **Req 1 (native client upload)** — SATISFIED. `blob-upload-client.ts` uses `@vercel/blob/client` `upload()` with `multipart:true`, optional `onUploadProgress`; no tus/uppy. Handshake uses `handleUpload`.
- **Req 2 (token secrecy)** — SATISFIED. `upload-token` uses server-side `handleUpload`; no `BLOB_READ_WRITE_TOKEN` in any client module (grep confirmed comments-only); client imports `@vercel/blob/client`; tokenPayload carries no secret.
- **Req 3 (auth before permission)** — SATISFIED. Both routes call `verifyRequest` before minting/inserting; 401/500 mapped; event resolved (404) with authenticated user.
- **Req 4 (demo on every entry point)** — SATISFIED for implemented paths. `isDemoEvent` + `isDemoUser` in `upload-token` (pre-token, plus re-asserted in `onBeforeGenerateToken`) and `confirm`; legacy `media/route.ts` and `bulk/route.ts` keep `demoGuardResponse()`. Recovery calls confirm, so the server enforces demo. Caveat: Req 4.3 (demo-safe reconciliation) is unverifiable because `onUploadCompleted` is a stub — it currently creates no row for anyone, which is demo-safe by omission but not by design.
- **Req 5 (image compression)** — SATISFIED. `image-preprocess.ts` implements all 5.1–5.8 (content-type check first, 2000px clamp, ~0.8 quality, EXIF orientation, skip small/video/non-image, don't-enlarge).
- **Req 6 incl. 6.6 persisted enqueue `date`** — SATISFIED. Store captures `date` once at enqueue (`upload.store.ts` `enqueueFiles`: `date: new Date().toISOString()`); `toRecord` passes `item.date`; `upload-queue.ts` `patch` forces `date: existing.date` (immutable, backward-safe: absent stays absent).
- **Req 7 / 13.3 / 22 (idempotency)** — SATISFIED. `confirm` inserts `ON CONFLICT (upload_id) DO NOTHING RETURNING *`, returns existing row (200) on conflict via follow-up SELECT; migration provides the partial unique index. Integrity guard on >1 row returns 500 (no silent delete).
- **Req 8 / 20 / 21 (orphan cleanup, no false completed, blob-succeeds/db-fails)** — SATISFIED in confirm route (this is Task 5.2's content). `head` existence check before insert; `del(blobUrl)` best-effort on DB failure; generic 500; store only marks `success` after confirm 200/201. **8.4 reconciliation NOT satisfied** (Gap G1).
- **Req 9 / 15 (BlurHash + next/image)** — NOT YET (Phase 7). `media-item.tsx` shows BlurHash while `!loaded` and transitions (pre-existing), but no `priority`, `sizes` is `50vw` not two-column, no intrinsic dims; `blurhash-canvas.tsx` re-decodes on dependency change (no memo tuning).
- **Req 10 (progress/retry/cancel)** — PARTIAL. Progress, retry, cancel all implemented in the store; `cancelItem` is **not wired into any UI** (grep: only defined/commented in the store). Req 10.5 (user can cancel) is not user-reachable. Placeholder UI exposes retry/dismiss only.
- **Req 14 (recovery incl. 14.4/14.9/14.10/14.11)** — SATISFIED. `recoverInterrupted` implements completed-removal, confirm-only (blobUrl+persisted date), legacy date-less surfaced (14.11), no-blobUrl restart-surface, run-once guard. Integrity halt (14.9) is enforced server-side in confirm (>1 row → 500) rather than client-side; the client keeps/surfaces on confirm failure.
- **Req 16 (live-schema-verified migration)** — SATISFIED (file-level). `002_add_upload_id_column.sql` matches approved DDL (nullable `upload_id` + partial unique index). Live application to Neon trusted per instructions (not queried).
- **Req 17 (no auth/demo regression)** — SATISFIED. `auth.ts` is a faithful extraction; legacy routes untouched; new routes replicate checks.
- **Req 18 (no silent errors / no debug logging)** — SATISFIED for new code. Every store failure path sets error + user-facing status and patches the queue; no `console.log` in new client paths (server uses `console.error` for server-side logging, which is allowed).

## D) Spec-vs-Implementation Drift

1. **`onUploadCompleted` stub vs design D1/Req 8.4** — Design and Req 8.4 require production reconciliation (idempotent insert if row missing). Implementation is an explicit no-op stub. This is the real functional divergence (Gap G1), and it is correctly labeled a stub in code, but Req 8.4 is unmet.

2. **Confirm `date` semantics vs design Component 3 comment** — Design Component 3 still comments `date: string; // ISO, as today`. The implementation threads the **enqueue-time** date (captured once in `enqueueFiles`, persisted in the queue, reused by same-session confirm and confirm-only recovery) — not a confirm-time date. Requirements 6.6/14.10 describe this amended behavior correctly, so the code matches requirements; the design Component 3 inline comment is stale/ambiguous and should be reconciled to say "enqueue-time ISO date".

3. **Status model superset** — Design Component 7 lists `UploadStatus = 'queued|processing|uploading|completed|failed|canceled'`. The store implements a superset that keeps legacy UI literals: `completed` is surfaced as `success`, plus `exhausted` (retry cap) in addition to `canceled`. This deviation is **documented in the store header** (kept for UI compat, constraints 1/17) and mapped to the persisted `QueueStatus` at the persistence boundary via `toQueueStatus`. Documented, not silent — but design Component 7 itself does not capture it.

4. **Pathname strategy vs design** — Design implied `onBeforeGenerateToken` returns a namespaced `pathname`. Because `@vercel/blob@2.3.1` cannot override the client pathname, the implementation instead **validates** the client-sent pathname against a recomputed `expectedPathname` and rejects mismatches (400). The client builds the pathname via shared `lib/upload-path.ts`; the server route has its **own inline `safeBasename` copy**. Verified today: the two `safeBasename` bodies are **byte-identical** (only the `export` keyword differs). The Task 7.2-recommended dedupe (server importing the shared module) was **not done** — a live duplication/drift risk if one copy changes. (Drift D-dup.)

5. **`confirm` processedSize `> 0` vs recovery fallback** — `confirm` requires `processedSize > 0`. Confirm-only recovery in the store falls back `processedSize ?? originalSize` when the persisted value is null/≤0, so the confirm body always sends a positive value. Consistent; no gap.

6. **Task 5.2 as a separate task** — 5.2's described behavior (orphan cleanup + no-false-completed) lives entirely inside the 5.1 confirm route. tasks.md still lists 5.2 as its own unchecked task. Reconcile: mark 5.2 complete (satisfied-by-5.1) or re-scope.

## E) Special-Attention Checklist

- **Neon `upload_id` migration** — `002_*.sql` present, matches DDL (live apply trusted). OK.
- **auth.ts** — verbatim extraction, 401/500. OK.
- **upload-token route** — auth→demo→event→payload→pathname; `onUploadCompleted` STUB. OK except reconciliation.
- **confirm route** — idempotent insert, blob-belongs-to-event, `head` check, orphan `del`, integrity guard. OK.
- **image-preprocess.ts** — full Req 5 behavior + graceful degrade. OK.
- **upload-path.ts** — shared `safeBasename`/`buildCanonicalPathname`; byte-identical to route copy today. OK (dedupe follow-up outstanding).
- **blob-upload-client.ts** — `@vercel/blob/client` only, multipart, progress, abort. OK.
- **upload-queue.ts** — IndexedDB metadata-only, graceful degrade, immutable `date`. OK.
- **upload.store.ts** — orchestration + attempt-token stale-async guard + single `crypto.randomUUID()` at enqueue (verified: exactly one, line 477). OK.
- **enqueue-time persisted date** — captured once, immutable, reused. OK.
- **confirm-only recovery** — implemented with persisted date, legacy date-less surfaced. OK.
- **retry/cancel/stale-async guards (attempt token)** — implemented; per-item `attempt` integer invalidates superseded/removed continuations. OK.
- **demo authorization** — enforced on all implemented entry points + legacy + bulk. OK.
- **Blob security/pathname validation** — validated + rejected on mismatch; blobUrl prefix checked at confirm. OK.
- **idempotency** — DB unique index + ON CONFLICT. OK.
- **orphan Blob cleanup** — best-effort `del` on DB failure and on conflict-but-no-row. OK.
- **onUploadCompleted reconciliation** — NOT IMPLEMENTED (stub). GAP.
- **legacy upload path** — `media/route.ts`, `media/bulk/route.ts`, `upload-xhr.ts` all present and intact. Store no longer calls the legacy XHR path; `upload-xhr.ts` is now unreferenced. OK (removal is Task 13.10).
- **UI integration** — navbar `enqueueFiles` drives the new store path; masonry renders placeholders + wires retry/dismiss. New path IS driving the UI. `cancelItem` NOT wired (GAP, Req 10.5). Phase 7 polish NOT done.
- **tests/verification** — no test framework, no `fast-check`, no tests. All of Phase 8 outstanding.

## F) Static Verification Results

- **`npx tsc --noEmit`** — PASS (exit 0, no errors).
- **`npx eslint <implemented files>`** — PASS (0 errors, 1 warning): `upload.store.ts:473 '_eventSlug' is defined but never used` — benign; `enqueueFiles` intentionally ignores the passed slug and derives it from the URL via `getEventSlug()`.
- **`git status` / `git diff --stat`** — branch `ui-polish`. Modified: `app/[event-slug]/page.tsx` (+17), `app/src/stores/upload.store.ts` (+910/-168 vs old HEAD). Untracked (new-file tasks): `lib/auth.ts`, `lib/blob-upload-client.ts`, `lib/image-preprocess.ts`, `lib/upload-path.ts`, `lib/upload-queue.ts`, `migrations/002_add_upload_id_column.sql`, both new route dirs, and the spec dir. Matches expectation (prior-task files untracked; large store diff).
- **Security greps** — `BLOB_READ_WRITE_TOKEN`/`JWT_SECRET` appear in client modules **only in comments** (image-preprocess, blob-upload-client, upload-queue), never as code. Client modules import `@vercel/blob/client` (not the server entrypoint). No secret leak.
- **Debug `console.log`** — none in any new client/server upload path (server routes use `console.error` for server-only logging, which Req 18.4 permits).
- **`crypto.randomUUID()` count in `upload.store.ts`** — exactly 1 (line 477, enqueue path).

## G) Gaps Found

- **G1 (blocks production reconciliation) — `onUploadCompleted` is a no-op stub.** `app/api/event/[event-slug]/media/upload-token/route.ts` `onUploadCompleted` returns `void`. Req 8.4 / design D1 require an idempotent insert-if-missing (demo-safe, only if the original upload succeeded). Impact: on the confirm-success path everything is fine, but a client that uploads to Blob and then never reaches `confirm` (tab closed before confirm, confirm network loss with no later recovery) leaves an orphaned Blob with no row in production, which reconciliation was meant to heal. Does not affect local dev (webhook never fires on localhost). **Blocks production-ready per the spec's own definition (Task 5.3 / 13.7).**

- **G2 (functional gap, not a security hole) — `cancelItem` not exposed in UI.** The store implements cancel correctly, but no component calls it (`media-item-placeholder.tsx` wires only retry/dismiss; grep finds no `cancelItem` consumer). Req 10.5 (user can cancel an in-flight upload) is unmet at the UI layer. Non-blocking for correctness (uploads still complete/fail), but an unmet requirement.

- **G3 (drift risk) — duplicated `safeBasename`.** Byte-identical today between `lib/upload-path.ts` and the inline copy in the upload-token route, but not shared. If one changes and the other doesn't, the pathname contract breaks (client pathname would mismatch server `expectedPathname` → all uploads 400). The Task 7.2 dedupe follow-up is outstanding.

- **G4 (incomplete phases, expected) — Phase 7 + Phase 8 not done.** No `priority`/two-column `sizes`/intrinsic dims (11.1), no BlurHash re-decode tuning (11.2), no selector-scoped masonry subscription (9.5), no test framework/tests (13.1–13.7), no formal error-matrix/security audits (13.8/13.9), legacy route not removed (13.10), production build not run (13.11).

No demo bypass, no secret leak, no broken idempotency guarantee, and no tsc/eslint failure were found.

## H) Recommended Next-Step Order

1. **Mark complete (already satisfied):** Task 5.2 (orphan cleanup + no-false-completed is fully in the 5.1 confirm route). Reconcile design Component 3's `date` comment to "enqueue-time ISO" and note the status-superset deviation in the design.

2. **Still requires implementation, sensible order:**
   - Task 5.3 — implement `onUploadCompleted` reconciliation (extract a shared idempotent-insert helper reused by confirm; demo-safe; insert-if-missing). Closes G1.
   - Req 10.5 / G2 — wire `cancelItem` into `media-item-placeholder.tsx` for in-flight items.
   - Task 9.5 — switch masonry/placeholder to per-item selector subscriptions.
   - Task 11.1 / 11.2 — `next/image` priority/sizes/intrinsic dims and BlurHash re-decode guard.

3. **Remove / merge / re-scope:** mark 5.2 done or merge into 5.1; do the Task 7.2 `safeBasename` dedupe (server imports `lib/upload-path.ts`) to close G3; defer legacy `media/route.ts` + `upload-xhr.ts` removal to 13.10 after the new path is proven on preview.

4. **Tests/verification before production-ready:** add `fast-check` + a test runner (13.1); unit tests (13.2); properties P1/P4/P6 first, then P2/P3/P5/P7 (13.3–13.6); preview integration for `onUploadCompleted` after 5.3 lands (13.7); error-matrix + security audits (13.8/13.9); final `npm run build` (13.11).
