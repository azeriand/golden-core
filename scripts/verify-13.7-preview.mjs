// scripts/verify-13.7-preview.mjs
//
// MANUAL / INTEGRATION verification for Task 13.7 — the REAL Vercel Blob
// `onUploadCompleted` reconciliation path against a LIVE Vercel Preview
// Deployment. This is NOT run by `npm test` or CI: vitest's include glob is
// `**/*.{test,spec}.{ts,tsx}` and `scripts/` is outside it, so this file is
// never collected by the default test run.
//
// It REQUIRES a live preview deployment + Preview-scoped env. DO NOT COMMIT
// SECRETS. Every credential/URL is read from environment variables at runtime;
// nothing is hardcoded. If a required env var is missing, the script no-ops with
// a clear message (so running it locally without infra does nothing dangerous
// and reveals no secrets).
//
// WHAT IT DOES (all REAL, no mocks):
//   1. Drives a REAL `@vercel/blob/client` upload() against the preview URL:
//      this performs the REAL upload-token handshake against the deployed route
//      and the REAL direct-to-Blob PUT, which triggers the REAL onUploadCompleted
//      webhook on the preview. It does NOT mock handleUpload / @vercel/blob /
//      Neon, does NOT call onUploadCompleted directly, and does NOT INSERT into
//      the DB directly.
//   2. (Optional) sends a REAL client confirm for the same uploadId, unless
//      VERIFY_SKIP_CONFIRM is set (to observe the webhook-only ordering).
//   3. Polls a READ-ONLY Neon connection for the single media row by uploadId and
//      asserts the invariants (count==1, ids match, content == blob url, type ==
//      blob content type, date == enqueue-time date).
//
// It prints ONLY non-sensitive identifiers (uploadId, eventId, media_id, blob
// pathname, preview URL). It never prints tokens, cookies, the tokenPayload, or
// DB credentials.
//
// Usage (from repo root, with env exported):
//   node scripts/verify-13.7-preview.mjs
//
// Required env (NAMES only — never put values in the repo):
//   PREVIEW_URL                 e.g. https://golden-core-<hash>.vercel.app
//   VERIFY_EVENT_SLUG           a REAL non-demo event slug
//   VERIFY_AUTH_COOKIE          the whole cookie header value, e.g. "auth_token=<jwt>"
//   VERIFY_FIXTURE_PATH         path to a small valid image fixture
//   VERIFY_READONLY_DATABASE_URL  a READ-ONLY Neon connection string
// Optional env:
//   VERIFY_EXPECTED_EVENT_ID    assert media.event_id equals this
//   VERIFY_EXPECTED_USER_ID     assert media.user_id equals this
//   VERIFY_ENQUEUE_DATE         ISO date to send + assert (default: now at start)
//   VERIFY_SKIP_CONFIRM         if set to "1"/"true", do NOT send client confirm
//                               (observe webhook-only reconciliation ordering)
//   VERIFY_POLL_ATTEMPTS        read-only poll attempts (default 20)
//   VERIFY_POLL_INTERVAL_MS     ms between polls (default 1500)

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';

const REQUIRED = [
  'PREVIEW_URL',
  'VERIFY_EVENT_SLUG',
  'VERIFY_AUTH_COOKIE',
  'VERIFY_FIXTURE_PATH',
  'VERIFY_READONLY_DATABASE_URL',
];

function log(msg) {
  console.log(`[verify-13.7] ${msg}`);
}

function fail(msg) {
  console.error(`[verify-13.7] FAIL: ${msg}`);
  process.exitCode = 1;
}

/**
 * Guard: no-op with a clear message if any required env var is absent. Running
 * this locally without infra therefore does nothing dangerous and reveals no
 * secrets.
 */
function checkEnvOrNoop() {
  const missing = REQUIRED.filter((k) => !process.env[k] || process.env[k].length === 0);
  if (missing.length > 0) {
    log('SKIPPED — this is a manual/integration check that requires a live');
    log('Vercel Preview deployment + Preview-scoped env. Nothing was run.');
    log(`Missing required env var(s): ${missing.join(', ')}`);
    log('See docs/verification/task-13.7-preview-onUploadCompleted.md for setup.');
    log('No secrets were read or printed.');
    return false;
  }
  return true;
}

function truthy(v) {
  return v === '1' || v === 'true' || v === 'yes';
}

async function main() {
  log('MANUAL/INTEGRATION verification — requires a live preview + Preview env.');
  log('Not run by npm test/CI. Do NOT commit secrets.');

  if (!checkEnvOrNoop()) return;

  const previewUrl = process.env.PREVIEW_URL.replace(/\/+$/, '');
  const eventSlug = process.env.VERIFY_EVENT_SLUG;
  const authCookie = process.env.VERIFY_AUTH_COOKIE; // never printed
  const fixturePath = process.env.VERIFY_FIXTURE_PATH;
  const readonlyDbUrl = process.env.VERIFY_READONLY_DATABASE_URL; // never printed
  const skipConfirm = truthy(process.env.VERIFY_SKIP_CONFIRM ?? '');
  const enqueueDate = process.env.VERIFY_ENQUEUE_DATE || new Date().toISOString();
  const pollAttempts = Number(process.env.VERIFY_POLL_ATTEMPTS || '20');
  const pollIntervalMs = Number(process.env.VERIFY_POLL_INTERVAL_MS || '1500');

  const uploadId = randomUUID();
  log(`preview URL: ${previewUrl}`);
  log(`event slug: ${eventSlug}`);
  log(`generated uploadId: ${uploadId}`);
  log(`enqueue-time date (will be asserted on the row): ${enqueueDate}`);
  log(`client confirm: ${skipConfirm ? 'SKIPPED (webhook-only ordering)' : 'will be sent'}`);

  // --- Dynamic imports so the missing-infra no-op above never requires deps. ---
  // @vercel/blob/client is present in the repo; pg is present. No new deps added.
  const { upload } = await import('@vercel/blob/client');
  const pg = await import('pg');

  // --- Load the small image fixture (real bytes). -----------------------------
  let fixtureBuf;
  try {
    fixtureBuf = await readFile(fixturePath);
  } catch (e) {
    fail(`could not read fixture at VERIFY_FIXTURE_PATH (${e?.code || 'error'})`);
    return;
  }
  const filename = basename(fixturePath);
  // Derive a conservative image content type from the extension; the fixture
  // must be a valid image with an allowed content type (see route ALLOWED list).
  const ext = filename.toLowerCase().split('.').pop();
  const contentType =
    ext === 'png'
      ? 'image/png'
      : ext === 'webp'
        ? 'image/webp'
        : ext === 'gif'
          ? 'image/gif'
          : 'image/jpeg';
  const body = new Blob([fixtureBuf], { type: contentType });

  // The server recomputes the pathname as
  //   events/{eventId}/{uploadId}/{safeBasename(filename)}
  // and rejects any mismatch. We don't know eventId client-side, but the
  // @vercel/blob/client upload() sends the pathname we pass; to satisfy the
  // server contract exactly, we let the DEPLOYED client flow decide. Here we
  // build the same safeBasename and rely on VERIFY_EXPECTED_EVENT_ID if the
  // server needs it. If eventId is unknown, the deployed UI (Option A in the
  // runbook) is the more robust driver. We attempt with the expected event id
  // when provided.
  const expectedEventId = process.env.VERIFY_EXPECTED_EVENT_ID
    ? Number(process.env.VERIFY_EXPECTED_EVENT_ID)
    : undefined;

  const safeName = filename
    .split(/[\\/]/)
    .pop()
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^\.+/, '') || 'upload';

  if (expectedEventId === undefined) {
    log('NOTE: VERIFY_EXPECTED_EVENT_ID not set. The server enforces the pathname');
    log('events/{eventId}/{uploadId}/{safeName}; without the eventId the client');
    log('cannot pre-build a matching pathname. Prefer the deployed UI (runbook');
    log('Option A) or set VERIFY_EXPECTED_EVENT_ID to the resolved event id.');
    fail('VERIFY_EXPECTED_EVENT_ID required for the script-driven upload path.');
    return;
  }

  const pathname = `events/${expectedEventId}/${uploadId}/${safeName}`;
  log(`blob pathname (pre-suffix): ${pathname}`);

  // --- 1. REAL direct-to-Blob upload via the deployed handshake. --------------
  // This triggers the REAL onUploadCompleted on the preview. We forward the auth
  // cookie so the deployed upload-token route authenticates the real user.
  let blobResult;
  try {
    blobResult = await upload(pathname, body, {
      access: 'public',
      handleUploadUrl: `${previewUrl}/api/event/${eventSlug}/media/upload-token`,
      contentType,
      multipart: true,
      clientPayload: JSON.stringify({
        uploadId,
        eventSlug,
        filename,
        contentType,
        size: body.size,
        date: enqueueDate,
      }),
      // Forward the real non-demo auth cookie to the handshake request so the
      // deployed route's verifyRequest authenticates the user. Never logged.
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set('cookie', authCookie);
        return fetch(input, { ...init, headers });
      },
    });
  } catch (e) {
    fail(`real upload() rejected: ${e?.message || 'error'}`);
    return;
  }
  log(`upload() resolved. blob pathname: ${blobResult.pathname}`);
  log(`blob url host/path only: ${new URL(blobResult.url).pathname}`);

  // --- 2. Optional REAL client confirm for the same uploadId. -----------------
  if (!skipConfirm) {
    try {
      const res = await fetch(
        `${previewUrl}/api/event/${eventSlug}/media/confirm`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie: authCookie, // never logged
          },
          body: JSON.stringify({
            uploadId,
            blobUrl: blobResult.url,
            filename,
            contentType,
            originalSize: body.size,
            processedSize: body.size,
            date: enqueueDate,
            blurhash: null,
          }),
        },
      );
      log(`confirm responded HTTP ${res.status} (expect 200/201)`);
    } catch (e) {
      fail(`confirm request failed: ${e?.message || 'error'}`);
      // continue to the read-only assertion anyway — the webhook may still win
    }
  } else {
    log('Skipping client confirm: expecting onUploadCompleted to reconcile alone.');
  }

  // --- 3. READ-ONLY assertion of the single media row by uploadId. ------------
  const client = new pg.default.Client({
    connectionString: readonlyDbUrl,
    ssl: { rejectUnauthorized: false },
  });
  try {
    await client.connect();
  } catch (e) {
    fail(`could not connect read-only to Neon: ${e?.message || 'error'}`);
    return;
  }

  let row;
  try {
    for (let attempt = 1; attempt <= pollAttempts; attempt++) {
      const { rows } = await client.query(
        `SELECT media_id, upload_id, event_id, user_id, content, type, date, section_id, blurhash
         FROM media
         WHERE upload_id = $1`,
        [uploadId],
      );
      if (rows.length > 1) {
        fail(`INTEGRITY: ${rows.length} rows for uploadId (expected exactly 1)`);
        return;
      }
      if (rows.length === 1) {
        row = rows[0];
        log(`row found on poll attempt ${attempt}`);
        break;
      }
      if (attempt < pollAttempts) {
        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }
    }
  } finally {
    await client.end().catch(() => {});
  }

  if (!row) {
    fail('no media row appeared for uploadId within the polling window');
    return;
  }

  // --- Assertions (print only non-sensitive identifiers). ---------------------
  let ok = true;
  const assert = (cond, label) => {
    if (cond) {
      log(`OK   ${label}`);
    } else {
      ok = false;
      fail(label);
    }
  };

  log(`media_id: ${row.media_id}  event_id: ${row.event_id}  user_id: ${row.user_id}`);
  assert(row.upload_id === uploadId, 'upload_id matches the test uploadId');
  assert(row.event_id === expectedEventId, `event_id == expected (${expectedEventId})`);
  if (process.env.VERIFY_EXPECTED_USER_ID) {
    assert(
      row.user_id === Number(process.env.VERIFY_EXPECTED_USER_ID),
      `user_id == expected (${process.env.VERIFY_EXPECTED_USER_ID})`,
    );
  }
  assert(row.content === blobResult.url, 'content points to the uploaded Blob url');
  assert(row.type === (blobResult.contentType ?? contentType), 'type == Blob content type');
  const rowDateIso = row.date instanceof Date ? row.date.toISOString() : String(row.date);
  assert(
    Date.parse(rowDateIso) === Date.parse(enqueueDate),
    `date == enqueue-time date (${enqueueDate})`,
  );

  if (ok) {
    log('ALL ASSERTIONS PASSED — real onUploadCompleted / confirm converged on one row.');
  } else {
    log('One or more assertions FAILED — see FAIL lines above.');
  }
}

main().catch((e) => {
  // Never print secrets in an unexpected error.
  fail(`unexpected error: ${e?.message || 'error'}`);
});
