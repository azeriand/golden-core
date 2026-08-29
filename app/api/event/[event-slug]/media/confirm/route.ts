// POST /api/event/[event-slug]/media/confirm
//
// Primary media-row creation after a direct-to-Blob client upload resolves
// (Task 5.1, design Component 3 + confirmUpload pseudocode). The browser has
// already uploaded the bytes directly to Vercel Blob (via the upload-token
// handshake); this route is the RELIABLE source of truth that creates exactly
// one `media` row per upload, keyed by the client-generated `upload_id`
// correlation id (design D1/D3).
//
// This is an additive sibling to the legacy `POST .../media` route and the
// `upload-token` handshake route, both of which are left untouched. It reuses
// the SAME auth (lib/auth.ts) and demo-guard (lib/demo-guard.ts) checks, the
// SAME event-resolution query, the SAME INSERT column set (adding upload_id),
// and the SAME namespacing convention (`events/{eventId}/{uploadId}/...`) as the
// handshake route so the blob-belongs-to-event check stays consistent.
//
// Idempotency is enforced by the DATABASE: the partial unique index
// `media_upload_id_key` on `upload_id` makes `ON CONFLICT (upload_id) DO NOTHING`
// the atomic dedupe primitive. A repeated confirmation (lost response, retry,
// reconciliation) can NEVER create a second row (Req 7.5/7.6/22, design P1).
//
// Blob-succeeds/DB-fails safety (approved Req 20/21): the Blob existence is
// verified server-side BEFORE any insert; if the insert then fails for a real
// (non-conflict) reason, the just-verified Blob is deleted best-effort so no
// orphaned Blob is left behind, and a generic 500 is returned. A row is never
// created unless both the Blob exists and the insert succeeds (Req 20.1/20.2).
//
// BLOB_READ_WRITE_TOKEN stays server-side: `head`/`del` read it from the server
// env by default; it is never exposed to the client, never returned, never
// logged (Req 2.x).

import { NextRequest } from 'next/server';
import { head, del, BlobNotFoundError } from '@vercel/blob';

import pool from '@/lib/db';
import { verifyRequest } from '@/lib/auth';
import { isDemoEvent, isDemoUser, demoGuardResponse } from '@/lib/demo-guard';

export const runtime = 'nodejs';

// --- Validation limits/types reused verbatim from the legacy + handshake route
// Source: app/api/event/[event-slug]/media/route.ts and
// app/api/event/[event-slug]/media/upload-token/route.ts. Do NOT invent new
// limits — these must match current app behavior (Req 9, 7.9, 19.11/19.12).

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB (legacy MAX_FILE_SIZE)

const ALLOWED_IMAGE_CONTENT_TYPES = [
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/heic',
    'image/heif',
    'image/gif',
    'image/bmp',
    'image/tiff',
];
const ALLOWED_VIDEO_CONTENT_TYPES = [
    'video/quicktime',
    'video/mp4',
    'video/webm',
    'video/x-msvideo',
    'video/3gpp',
    'video/x-matroska',
];
const ALLOWED_CONTENT_TYPES = new Set<string>([
    ...ALLOWED_IMAGE_CONTENT_TYPES,
    ...ALLOWED_VIDEO_CONTENT_TYPES,
]);

// UUID v4-ish validation (correlation id). Matches the handshake route regex so
// the same uploadId format is accepted end-to-end (Req 7.3/7.4).
const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Design Component 3 ConfirmUploadBody.
interface ConfirmUploadBody {
    uploadId: string;
    blobUrl: string;
    filename: string;
    contentType: string;
    originalSize: number;
    processedSize: number;
    date: string;
    blurhash?: string | null;
}

type ParsedBody = ConfirmUploadBody | { error: string };

/**
 * Parse and validate the JSON confirm body. Returns the typed body on success
 * or `{ error }` on any validation failure. Every failure maps to a generic 400
 * by the caller (no server internals leaked, Req 19.13).
 *
 * Ordering note (Req 7.4): the `uploadId`-must-be-a-UUID check is enforced here
 * as part of body validation, so a malformed uploadId ALWAYS yields 400 and no
 * row, regardless of any other condition.
 */
function parseConfirmBody(raw: unknown): ParsedBody {
    if (typeof raw !== 'object' || raw === null) {
        return { error: 'Invalid confirm request' };
    }

    const p = raw as Record<string, unknown>;

    const {
        uploadId,
        blobUrl,
        filename,
        contentType,
        originalSize,
        processedSize,
        date,
        blurhash,
    } = p;

    // uploadId must be a valid UUID — always 400 on failure (Req 7.4).
    if (typeof uploadId !== 'string' || !UUID_RE.test(uploadId)) {
        return { error: 'Invalid confirm request' };
    }
    if (typeof blobUrl !== 'string' || blobUrl.length === 0) {
        return { error: 'Invalid confirm request' };
    }
    if (typeof filename !== 'string' || filename.length === 0) {
        return { error: 'Invalid confirm request' };
    }
    if (typeof contentType !== 'string' || !ALLOWED_CONTENT_TYPES.has(contentType)) {
        return { error: 'Invalid confirm request' };
    }
    if (typeof date !== 'string' || date.length === 0) {
        return { error: 'Invalid confirm request' };
    }
    if (
        typeof originalSize !== 'number' ||
        !Number.isFinite(originalSize) ||
        originalSize <= 0 ||
        originalSize > MAX_FILE_SIZE
    ) {
        return { error: 'Invalid confirm request' };
    }
    if (
        typeof processedSize !== 'number' ||
        !Number.isFinite(processedSize) ||
        processedSize <= 0 ||
        processedSize > MAX_FILE_SIZE
    ) {
        return { error: 'Invalid confirm request' };
    }
    // blurhash is optional; if present must be a string (persisted as-is) or null.
    if (blurhash !== undefined && blurhash !== null && typeof blurhash !== 'string') {
        return { error: 'Invalid confirm request' };
    }

    return {
        uploadId,
        blobUrl,
        filename,
        contentType,
        originalSize,
        processedSize,
        date,
        blurhash: typeof blurhash === 'string' ? blurhash : null,
    };
}

/**
 * Shape a raw `media` row into the Media DTO the client gallery consumes,
 * mirroring EXACTLY the per-media object GET /api/event/[event-slug] returns:
 *   { media_id, user_id, content, likes, liked, date, type, blurhash, username }
 *
 * RETURNING * on the media table has NO username/likes/liked (those are joins in
 * GET). The upload store appends this response object directly into
 * useEventStore.event.sections[].media, and the gallery filters
 * (media.user_id === user.id under "myPhotos") and renders username/likes/liked.
 * Shaping here makes new media appear live without a refresh.
 */
async function shapeMediaRow(
    row: {
        media_id: number;
        user_id: number;
        content: string;
        type: string | null;
        date: string;
        section_id: number | null;
        blurhash: string | null;
    },
    viewerUserId: number,
) {
    const meta = await pool.query(
        `SELECT
            users.username AS username,
            COALESCE(l.likes, 0) AS likes,
            EXISTS (
                SELECT 1 FROM likes user_like
                WHERE user_like.media_id = $1 AND user_like.user_id = $2
            ) AS liked
         FROM users
         LEFT JOIN (
            SELECT media_id, COUNT(*) AS likes FROM likes WHERE media_id = $1 GROUP BY media_id
         ) l ON TRUE
         WHERE users.user_id = $3`,
        [row.media_id, viewerUserId, row.user_id],
    );

    const info = meta.rows[0] ?? { username: null, likes: 0, liked: false };

    return {
        media_id: row.media_id,
        user_id: row.user_id,
        content: row.content,
        likes: Number(info.likes) || 0,
        liked: Boolean(info.liked),
        date: row.date,
        type: row.type,
        section_id: row.section_id,
        blurhash: row.blurhash,
        username: info.username ?? null,
    };
}

/**
 * Verify the Blob URL belongs to THIS event's server-controlled namespace so a
 * caller cannot attach an arbitrary Blob URL to a media row (Req 3.x/security).
 * The handshake route mints tokens scoped to the pathname
 * `events/{eventId}/{uploadId}/{safeName}` (with addRandomSuffix on the final
 * object), so the stored Blob's URL path must contain that prefix.
 */
function blobUrlBelongsToEvent(
    blobUrl: string,
    eventId: number,
    uploadId: string,
): boolean {
    let pathname: string;
    try {
        pathname = new URL(blobUrl).pathname; // leading slash, e.g. /events/12/<uuid>/name-abc.jpg
    } catch {
        return false;
    }
    const expectedPrefix = `/events/${eventId}/${uploadId}/`;
    return pathname.startsWith(expectedPrefix);
}

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ 'event-slug': string }> },
): Promise<Response> {
    // 1. Route param (params is a Promise in this Next.js version).
    const { 'event-slug': eventSlug } = await params;

    // 2. Demo authorization BEFORE any DB mutation / media creation (Req 4.9).
    //    Demo-event check may precede auth; then auth; then reject the demo user
    //    as defense in depth. No media row can be created for a demo event/user.
    if (isDemoEvent(eventSlug)) return demoGuardResponse();

    const auth = verifyRequest(request);
    if (!auth.ok) {
        // 401 (missing/invalid/expired token) or 500 (JWT_SECRET missing) — from
        // the shared helper; no server internals leaked (Req 3.5/3.6).
        return auth.response;
    }
    const user = auth.user;

    if (isDemoUser(user.email)) return demoGuardResponse(); // defense in depth

    // 3. Parse & validate the confirm body (Req 4, 7.3, 7.4, 7.9).
    let rawJson: unknown;
    try {
        rawJson = await request.json();
    } catch {
        return Response.json({ error: 'Invalid confirm request' }, { status: 400 });
    }

    const parsed = parseConfirmBody(rawJson);
    if ('error' in parsed) {
        return Response.json({ error: parsed.error }, { status: 400 });
    }
    const body = parsed;

    // 4. Resolve event_id from slug (404 if missing) — same query as legacy/handshake.
    let eventId: number;
    try {
        const eventResult = await pool.query(
            `SELECT event_id FROM events WHERE event_slug = $1`,
            [eventSlug],
        );
        if (eventResult.rows.length === 0) {
            return new Response('Event not found', { status: 404 });
        }
        eventId = eventResult.rows[0].event_id;
    } catch (error) {
        // Do not leak DB internals (Req 19.13); log server-side only (Req 18.4).
        console.error('confirm: error resolving event', error);
        return new Response('Could not resolve event', { status: 500 });
    }

    // Authorization mirrors the legacy route: any authenticated (non-demo) user
    // may upload to a resolved event; the demo user is already rejected above.
    // (Req 17.3/17.4: no weakening of legacy authorization.)

    // 5. Validate blobUrl belongs to THIS event's Blob namespace (400 on mismatch).
    if (!blobUrlBelongsToEvent(body.blobUrl, eventId, body.uploadId)) {
        return Response.json({ error: 'Invalid confirm request' }, { status: 400 });
    }

    // 6. Verify the Blob ACTUALLY EXISTS server-side before creating the row
    //    (Req 5, design P2/P3). Never assume client success == Blob exists.
    //    `head` uses BLOB_READ_WRITE_TOKEN from the server env (never exposed).
    try {
        await head(body.blobUrl);
    } catch (error) {
        if (error instanceof BlobNotFoundError) {
            // Client claimed success but the Blob is not there — do not create a row.
            return Response.json({ error: 'Blob not found' }, { status: 409 });
        }
        // Unexpected error contacting Blob storage — generic 500, log server-side.
        console.error('confirm: error verifying blob existence', error);
        return new Response('Could not verify upload', { status: 500 });
    }

    // 7. Resolve section using EXISTING metadata semantics (Req 9).
    //    The confirm route receives no raw file buffer, so no EXIF photo-time is
    //    available here (unlike the legacy route). This matches the legacy
    //    "no photoTime" branch: assign the default 'Sin clasificar' section.
    //    `type` reuses the client-resolved MIME (already validated against the
    //    same allowed image/video set as the legacy route). blurhash: persist
    //    the optional client-provided value as-is per design (Req 10) — no second
    //    server-side BlurHash implementation is introduced here.
    let sectionId: number;
    try {
        const fallback = await pool.query(
            `SELECT section_id FROM sections WHERE event_id = $1 AND section_name = 'Sin clasificar' LIMIT 1`,
            [eventId],
        );
        if (fallback.rows.length === 0) {
            console.error('confirm: default section not found for event', eventId);
            return new Response('Default section not found', { status: 500 });
        }
        sectionId = fallback.rows[0].section_id;
    } catch (error) {
        console.error('confirm: error finding section', error);
        return new Response('Error finding section', { status: 500 });
    }

    // 8 + 9. Idempotent insert keyed by upload_id (Req 7.5, 13.4, 22) with
    // Blob-succeeds/DB-fails cleanup (Req 8, 20, 21).
    //
    // The DB unique index (media_upload_id_key WHERE upload_id IS NOT NULL) is
    // the authoritative dedupe mechanism. ON CONFLICT (upload_id) DO NOTHING:
    //   - if a row is RETURNED -> it was newly inserted (201)
    //   - if NO row is returned -> a row already existed for this uploadId; we
    //     SELECT it and return it (200). This is the repeated-confirmation /
    //     lost-response / reconciliation case and must NEVER create a 2nd row.
    // The follow-up SELECT runs ONLY on conflict; it is not a race-prone
    // SELECT-then-INSERT primary path.
    try {
        const insertResult = await pool.query(
            `INSERT INTO media (content, type, date, user_id, section_id, event_id, blurhash, upload_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (upload_id) WHERE upload_id IS NOT NULL DO NOTHING
             RETURNING *`,
            [
                body.blobUrl,
                body.contentType,
                body.date,
                user.userId,
                sectionId,
                eventId,
                body.blurhash,
                body.uploadId,
            ],
        );

        if (insertResult.rows.length > 0) {
            // Newly inserted row.
            return Response.json(await shapeMediaRow(insertResult.rows[0], user.userId), { status: 201 });
        }

        // Conflict: a row already exists for this uploadId. Fetch and return it.
        const existing = await pool.query(
            `SELECT * FROM media WHERE upload_id = $1`,
            [body.uploadId],
        );

        // INTEGRITY GUARD (Req 14.9): more than one row for an uploadId should be
        // impossible given the unique index. If it ever happens, HALT and report
        // an integrity error — NEVER silently delete media rows.
        if (existing.rows.length > 1) {
            console.error(
                'confirm: INTEGRITY VIOLATION — multiple media rows for upload_id',
                body.uploadId,
                'count',
                existing.rows.length,
            );
            return new Response('Media integrity error', { status: 500 });
        }

        if (existing.rows.length === 1) {
            // Idempotent repeat: return the existing row (Req 7.6/22).
            return Response.json(await shapeMediaRow(existing.rows[0], user.userId), { status: 200 });
        }

        // Extremely unlikely: conflict reported but no row found on re-select
        // (e.g. concurrent delete). Treat as a real save failure and clean up.
        console.error(
            'confirm: conflict but no existing row found for upload_id',
            body.uploadId,
        );
        await del(body.blobUrl).catch((delErr) => {
            console.error('confirm: best-effort blob cleanup failed', delErr);
        });
        return new Response('Could not save media', { status: 500 });
    } catch (dbError) {
        // Real DB failure (not a conflict) AFTER the Blob was verified to exist.
        // Best-effort delete the orphaned Blob so no orphan is left (Req 8/21),
        // never mark completed (Req 20.1/20.2), log server-side only (Req 18.4),
        // and return a generic message (Req 19.6/19.13).
        console.error('confirm: DB insert failed, cleaning up orphaned blob', dbError);
        await del(body.blobUrl).catch((delErr) => {
            console.error('confirm: best-effort blob cleanup failed', delErr);
        });
        return new Response('Could not save media', { status: 500 });
    }
}
