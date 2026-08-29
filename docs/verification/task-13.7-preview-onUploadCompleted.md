# Task 13.7 — Manual Preview Verification Runbook: real `onUploadCompleted` reconciliation

> **Status when this file was written:** the runtime proof for Task 13.7 has **NOT**
> been executed. This runbook + the companion script
> (`scripts/verify-13.7-preview.mjs`) are the *artifacts* that let a maintainer run
> the real verification against a live Vercel Preview Deployment. No preview
> deployment, Preview-scoped secrets, real non-demo session, or safe Neon access
> exists in the workspace where these artifacts were prepared, so the task remains
> **BLOCKED / NOT-COMPLETE for the runtime proof** per the task's critical stopping
> rule.

---

## 0. Why this must run on a Preview deployment (not localhost)

Design decision **D1** (and Req 8.4): Vercel Blob's `onUploadCompleted` webhook
**does not fire against `localhost`** — it needs a publicly reachable deployment
URL. The client `confirm` route is the reliable source of truth; `onUploadCompleted`
is a **production-only idempotent reconciliation** path. Therefore the only honest
way to prove the real reconciliation lifecycle is on a **Preview Deployment**
(`vercel` preview build / a push to a preview branch), never on a local dev server.

What the earlier tasks already cover (and why they are NOT sufficient for 13.7):

| Task | What it proves | Evidence class |
|------|----------------|----------------|
| 13.2 `confirm.route.test.ts` | confirm handler branches (auth/demo/validation/idempotent insert/DB-fail cleanup) with `@/lib/db` and `@vercel/blob` **mocked** | Mocked |
| 13.3 P1 | confirm + reconciliation + restart interleavings converge on ≤1 row — over a **simulated** insert/`ON CONFLICT` model | Mocked / reasoned |
| 13.4 P4 | demo immutability across entry points — `handleUpload`/DB **mocked** | Mocked |
| 13.5 / 13.6 P2/P3/P5/P6/P7 | orphan-blob, token secrecy, preprocess safety, no-silent-errors — **mocked** boundaries | Mocked |

None of the above drives a **real** Vercel Blob upload, so none of them can make the
**real** `onUploadCompleted` webhook fire, and none touches the **real** Neon `media`
table. Task 13.7 is exactly the gap those mocks cannot close: *does the real webhook
fire on a preview, and do the real webhook + real confirm converge on exactly one
real row?*

---

## 1. The lifecycle this runbook verifies (confirmed from the code)

Confirmed by reading the production routes (do not modify them):

1. **Handshake** — `POST /api/event/{event-slug}/media/upload-token`
   (`app/api/event/[event-slug]/media/upload-token/route.ts`):
   - Auth (`verifyRequest`) → demo guard (`isDemoEvent` / `isDemoUser`) → resolve
     `event_id` from slug → `handleUpload`.
   - Client sends `clientPayload = { uploadId, eventSlug, filename, contentType, size, date }`.
   - `onBeforeGenerateToken` enforces: `uploadId` is a UUID, `eventSlug` matches the
     route param, `contentType ∈ ALLOWED_CONTENT_TYPES`, `size ≤ 100 MB`, and the
     client `pathname` equals `events/{eventId}/{uploadId}/{safeBasename(filename)}`.
   - Returns `allowedContentTypes`, `maximumSizeInBytes = 100 MB`,
     `addRandomSuffix: true`, and a **server-signed** `tokenPayload =
     { uploadId, userId, eventId, date }`. `date` is the **enqueue-time**
     upload-intent ISO string (Req 6.6 / 14.10), carried so reconciliation can
     reconstruct `media.date` without fabricating one.
2. **Direct-to-Blob upload** — the browser `@vercel/blob/client` `upload()` (via
   `lib/blob-upload-client.ts`) PUTs the bytes straight to Vercel Blob with
   `multipart: true`. `BLOB_READ_WRITE_TOKEN` never leaves the server.
3. **Reconciliation callback** — `onUploadCompleted` (in the same upload-token
   route, **production/preview only**): parses the signed `tokenPayload`, re-checks
   demo event, re-resolves the slug's `event_id` and asserts it equals
   `tokenPayload.eventId`, verifies `blob.pathname` is under
   `events/{eventId}/{uploadId}/`, `head(blob.url)` to confirm the blob really
   exists, resolves the default `Sin clasificar` section, then does the
   **idempotent insert**:
   ```sql
   INSERT INTO media (content, type, date, user_id, section_id, event_id, blurhash, upload_id)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
   ON CONFLICT (upload_id) DO NOTHING
   ```
   with `content = blob.url`, `type = blob.contentType`, `date = tokenPayload.date`,
   `blurhash = null`, `upload_id = tokenPayload.uploadId`.
4. **Client confirm** — `POST /api/event/{event-slug}/media/confirm`
   (`app/api/event/[event-slug]/media/confirm/route.ts`): same auth/demo guards,
   validates the body + `blobUrl` belongs to `events/{eventId}/{uploadId}/`, `head`
   the blob, resolves the section, then the **same** `INSERT ... ON CONFLICT
   (upload_id) DO NOTHING RETURNING *` (201 on fresh insert; on conflict, SELECT the
   existing row and return 200; >1 row ⇒ 500 integrity error, never deletes rows).

**Dedupe primitive:** the partial unique index from
`migrations/002_add_upload_id_column.sql`:
```sql
CREATE UNIQUE INDEX media_upload_id_key ON public.media (upload_id) WHERE upload_id IS NOT NULL;
```
This is what makes `confirm` and `onUploadCompleted` converge on **exactly one** row.

### `media` columns written by both paths (assert these)

| Column      | confirm value            | onUploadCompleted value        |
|-------------|--------------------------|--------------------------------|
| `content`   | `blobUrl`                | `blob.url`                     |
| `type`      | client `contentType`     | `blob.contentType`             |
| `date`      | confirm body `date`      | `tokenPayload.date` (enqueue)  |
| `user_id`   | authenticated `userId`   | `tokenPayload.userId`          |
| `section_id`| resolved section         | resolved `Sin clasificar`      |
| `event_id`  | resolved `event_id`      | `tokenPayload.eventId`         |
| `blurhash`  | optional client value    | `null`                         |
| `upload_id` | `uploadId`               | `tokenPayload.uploadId`        |

**Date semantics to assert:** the final `date` on the row MUST equal the
**enqueue-time** date carried in the signed token / confirm body — never `now()`,
never `updatedAt`.

---

## 2. Prerequisites

### 2.1 A live Vercel Preview Deployment

- Push the feature branch to trigger a Vercel Preview build, or run a preview
  deploy from the Vercel CLI. Capture the resulting **preview URL** (e.g.
  `https://golden-core-<hash>-<scope>.vercel.app`). `onUploadCompleted` will POST
  back to this deployment's upload-token route.

### 2.2 Preview-SCOPED environment variables (names only — never values)

Set these on the **Preview** environment (Vercel Project → Settings → Environment
Variables → *Preview* scope). List by **name only**; never paste a value into this
doc, a screenshot, a log, or a commit.

| Env var (NAME only) | Used by | Scope | Notes |
|---------------------|---------|-------|-------|
| `BLOB_READ_WRITE_TOKEN` | `handleUpload`, `head`, `del` (server) | Preview | Server-only Blob credential. Never sent to the client, never logged. |
| `JWT_SECRET` | `lib/auth.ts` `verifyRequest`, `app/utils/jwt.ts` login | Preview | Signs/verifies the `auth_token` cookie. |
| One Neon connection var read by `lib/db.ts` | `pool` in every server route | Preview | `lib/db.ts` reads, in order: `DATABASE_URL` → `DB_DATABASE_URL` → `DB_POSTGRES_URL`; else the discrete set `DB_PGHOST`/`DB_PGDATABASE`/`DB_PGUSER`/`DB_PGPASSWORD` (or the `DB_POSTGRES_*` equivalents), port 5432, SSL on. Provide whichever set the Preview uses. |

> The **verification script's own** read-only Neon connection (section 5) is a
> *separate*, read-only credential you supply to the script via its own env var
> (`VERIFY_READONLY_DATABASE_URL`) — it is NOT the app's write credential and is
> never committed.

### 2.3 A real, non-demo authenticated session

- You need a genuine **non-demo** user and a genuine **non-demo** event slug
  (`event_slug !== "demo"`, user email `!== "demo@golden-core.app"`).
- Obtain an `auth_token` cookie the same way the app does, via `POST
  /api/me/login` (`app/api/me/login/route.ts`) with that user's real
  email/password. The route sets an httpOnly `auth_token` cookie (3-day expiry).
  - Through the UI: log in on the preview site and copy the `auth_token` cookie
    from the browser devtools (Application → Cookies).
  - Headless: `curl -i -X POST "$PREVIEW_URL/api/me/login" -H 'content-type:
    application/json' -d '{"email":"...","password":"..."}'` and read the
    `Set-Cookie: auth_token=...` header.
- **Do NOT hardcode credentials** in this doc, the script, or anywhere in the repo.
  Pass the cookie/credentials to the script via environment variables only.

### 2.4 A small, deterministic image fixture

- A small valid JPEG/PNG (e.g. a ~10–50 KB image) so the upload is inexpensive and
  fast. Any real, valid image bytes with an allowed content type
  (`image/jpeg`/`image/png`/… from `ALLOWED_CONTENT_TYPES`) works. Keep it out of
  version control if it is not already a shared test asset; reference it by path
  via `VERIFY_FIXTURE_PATH`.

---

## 3. Authenticating a real non-demo user (summary)

1. Choose a real non-demo user + a real non-demo event slug on the preview DB.
2. `POST $PREVIEW_URL/api/me/login` with that user's credentials → capture the
   `auth_token` cookie value.
3. Export it for the script (name only shown):
   - `PREVIEW_URL` = the preview base URL
   - `VERIFY_EVENT_SLUG` = the real non-demo event slug
   - `VERIFY_AUTH_COOKIE` = `auth_token=<value>` (the whole cookie header value)
4. Never echo the cookie value into logs, screenshots, or the terminal scrollback
   you paste elsewhere (see section 9, Secrets hygiene).

---

## 4. The one controlled test upload

You have two equivalent ways to drive **one** real upload so the **real**
`onUploadCompleted` fires:

**Option A — deployed UI (simplest, fully real):**
1. On the preview site, log in as the non-demo user, open the non-demo event.
2. Upload the single small fixture image through the normal upload UI.
3. The browser runs `lib/blob-upload-client.ts` → `@vercel/blob/client upload()`
   → real Vercel Blob → real `onUploadCompleted` on the preview, and the client
   also calls `confirm`.

**Option B — the verification script (`scripts/verify-13.7-preview.mjs`):**
- The script drives the **real** client flow against the preview: it performs a
  real `@vercel/blob/client` `upload()` (which does the real handshake against the
  preview upload-token route and the real direct-to-Blob PUT), so the **real**
  `onUploadCompleted` fires. It does **not** mock `handleUpload`, `@vercel/blob`,
  or Neon, and it does **not** call `onUploadCompleted` directly or insert into the
  DB directly.

Pick **one** controlled upload per run and record its `uploadId` (the script
generates and prints it; in the UI path, read it from the queue record / network
tab).

> To isolate the **webhook-only** path (reconciliation without a client confirm),
> use the race procedure in section 6, ordering (A).

---

## 5. Observing the webhook and reading the row (read-only)

### 5.1 Confirm the webhook actually fired (trustworthy evidence)

- Open the Vercel deployment's **Runtime Logs** for the preview and filter to the
  upload-token function. `onUploadCompleted` logs server-side lines on its no-op /
  reconciliation branches (e.g. the `onUploadCompleted: media row already existed;
  reconciliation no-op` line when confirm won the race, or a clean insert with no
  error line when the webhook won). Seeing the upload-token function invoked
  **after** the blob upload (a second invocation distinct from the handshake) is
  the evidence the webhook reached the deployment.
- Capture the log timestamp + request id as evidence (these are non-sensitive).

### 5.2 Read-only Neon assertion for the single test `uploadId`

Run a **parameterized** single-row SELECT (never dump unrelated rows):

```sql
SELECT media_id, upload_id, event_id, user_id, content, type, date, section_id, blurhash
FROM media
WHERE upload_id = $1;   -- $1 = the test uploadId
```

Assert:
- **exactly one** row (`count == 1`);
- `upload_id == <test uploadId>`;
- `event_id == <expected event_id for the slug>`;
- `user_id == <authenticated user's id>`;
- `content` points to the uploaded Blob (starts with the event's Blob prefix and
  matches the returned `blobUrl`);
- `type == <Blob content type>` (image content type used);
- `date == <enqueue-time date carried in the signed token / confirm body>` — NOT
  `now()`, NOT `updatedAt`.

The script (section 8) performs exactly this parameterized read-only SELECT and
prints only non-sensitive identifiers.

---

## 6. Confirm / reconciliation RACE procedure

Prove both interleavings converge on exactly one row and a stable enqueue-time
`date`, with the Blob still present:

- **Ordering (A) — webhook reconciles BEFORE client confirm.** Drive the real
  `upload()` but **suppress / delay the client confirm** (e.g. use Option B and do
  not send confirm, or in the UI, block the confirm request in devtools). Let
  `onUploadCompleted` insert the row. Then send a `confirm` for the same
  `uploadId`. Expect: confirm returns **200** with the existing row (no second
  insert); still exactly one row; `date` unchanged; Blob still present.
- **Ordering (B) — client confirm BEFORE reconciliation.** Let the normal flow run
  (confirm inserts, 201). When `onUploadCompleted` later fires, its idempotent
  insert is a **no-op** (`ON CONFLICT DO NOTHING`, rowCount 0 → logs
  "reconciliation no-op"). Expect: still exactly one row; `date` unchanged; Blob
  still present.

Ordering (B) is reliably reproducible (it is the default happy path). Ordering (A)
requires forcing the webhook to win by withholding/delaying confirm; if forcing it
proves impractical on the preview, **document it as a limitation** and do not
fabricate a result — record which ordering was actually observed.

In both orderings assert: exactly one row, safe convergence, no duplicate, final
`date == enqueue-time date`, Blob remains.

---

## 7. Safe failure-path checks (no data damage)

These are safe because they never create nor delete unrelated data:

- **Malformed / invalid signed `tokenPayload` → no row.** The webhook path validates
  the signed `tokenPayload` (`parseTokenPayload`) and returns without inserting when
  it is missing/invalid. On the request side, a malformed confirm body / invalid
  `uploadId` returns 400 and creates no row. Verify with the read-only SELECT
  (section 5.2) that no row exists for that `uploadId`.
- **Mismatched `eventId` → no row.** If the slug's resolved `event_id` differs from
  the signed `tokenPayload.eventId` (or the confirm `blobUrl` is not under
  `events/{eventId}/{uploadId}/`), the paths refuse to insert (webhook logs
  "eventId mismatch"; confirm returns 400). Verify: no row for that `uploadId`.
- **Missing Blob → no row.** Both paths `head(blob.url)` first; a `BlobNotFoundError`
  means no row (webhook returns; confirm returns 409). To trigger safely, drive a
  confirm for a fresh, unused `uploadId` whose blob does not exist — this only ever
  *fails to create* a row; it never deletes anything.

Do **not** manually DELETE rows or blobs to simulate failures. Use fresh, unused
`uploadId`s so the checks are inherently non-destructive to existing data.

---

## 8. Using the companion script

`scripts/verify-13.7-preview.mjs`:
- Reads ALL credentials/URLs from **environment variables** at runtime
  (`PREVIEW_URL`, `VERIFY_AUTH_COOKIE`, `VERIFY_EVENT_SLUG`, `VERIFY_FIXTURE_PATH`,
  `VERIFY_READONLY_DATABASE_URL`, optional `VERIFY_EXPECTED_EVENT_ID`,
  `VERIFY_EXPECTED_USER_ID`, `VERIFY_SKIP_CONFIRM`). Nothing is hardcoded.
- No-ops with a clear message if any required env var is missing, so running it
  locally without infra does nothing dangerous and reveals no secrets.
- Drives the REAL flow: a real `@vercel/blob/client` `upload()` against the preview
  (real handshake + real direct-to-Blob PUT → real `onUploadCompleted`). It does
  NOT mock `handleUpload`/`@vercel/blob`/Neon, does NOT call `onUploadCompleted`
  directly, and does NOT insert into the DB directly.
- Polls a **read-only** Neon connection for the single `media` row by `uploadId`
  and asserts the section-5.2 invariants; prints ONLY non-sensitive identifiers.

Run (from the repo root, with the env vars exported):
```bash
node scripts/verify-13.7-preview.mjs
```
This script is **manual/integration only**: it is NOT run by `npm test` / CI
(vitest include is `**/*.{test,spec}.{ts,tsx}`, and `scripts/` is outside it).
Never commit secrets.

---

## 9. Secrets hygiene (mandatory)

Never print, log, screenshot, or commit any of:
- `BLOB_READ_WRITE_TOKEN`
- `JWT_SECRET`
- the signed Vercel Blob upload/client token
- the `auth_token` cookie or any `Authorization` header
- the full signed `tokenPayload`
- any DB credentials / connection string (app write cred or the read-only verify
  cred)

Only ever surface **non-sensitive** identifiers: `uploadId`, `eventId`, `media_id`,
the Blob `pathname`, and the preview URL. Redact everything else. The companion
script is written to print only these non-sensitive identifiers.

---

## 10. What a maintainer must supply to obtain the real proof

1. A live **Vercel Preview Deployment** URL for this branch.
2. **Preview-scoped** env vars set on the deployment (names in section 2.2):
   `BLOB_READ_WRITE_TOKEN`, `JWT_SECRET`, and the Neon connection var(s)
   `lib/db.ts` reads.
3. A real **non-demo** login (email + password) and a real **non-demo** event slug.
4. A **read-only** Neon connection string for the verification SELECT
   (`VERIFY_READONLY_DATABASE_URL`), plus the small image fixture path.

With those, run section 4 (one controlled upload) + section 6 (race) + section 7
(safe failure paths), confirm the webhook fired (section 5.1), and assert the
single-row invariants (section 5.2 / the script). Only then is the Task 13.7
runtime proof complete.
