// POST /api/event/[event-slug]/media/upload-token
//
// Authenticated handshake for direct-to-Blob client uploads (Task 3.1, design
// Component 2). This route is ONLY the authorization/handshake step: it verifies
// the JWT, enforces demo restrictions, resolves + authorizes the event, validates
// the client payload, and then lets Vercel Blob mint a short-lived client token
// via `@vercel/blob/client` `handleUpload`. It NEVER uploads bytes and NEVER
// creates a `media` row.
//
// BLOB_READ_WRITE_TOKEN stays server-side: `handleUpload` reads it from the
// server env by default, so it is never passed to the client, never returned in
// a response body, never placed in tokenPayload, and never logged (Req 2.1/2.3/2.5).
//
// This is an additive sibling to the legacy `POST .../media` route, which is left
// untouched.

import { NextRequest } from 'next/server';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { head, BlobNotFoundError } from '@vercel/blob';

import pool from '@/lib/db';
import { verifyRequest } from '@/lib/auth';
import { isDemoEvent, isDemoUser, demoGuardResponse } from '@/lib/demo-guard';

export const runtime = 'nodejs';

// --- Validation limits/types reused verbatim from the legacy route ------------
// Source: app/api/event/[event-slug]/media/route.ts (Finding 1.4 / Task 1.1).
// Do NOT invent new limits — these must match the current app behavior.

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB (legacy MAX_FILE_SIZE)

// Accepted MIME types derived from the legacy MIME_FROM_EXTENSION map. The
// authoritative server-side enforcement happens via `allowedContentTypes` in
// onBeforeGenerateToken (Req 19.11/19.12).
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
const ALLOWED_CONTENT_TYPES = [
    ...ALLOWED_IMAGE_CONTENT_TYPES,
    ...ALLOWED_VIDEO_CONTENT_TYPES,
];

// UUID v4-ish validation (correlation id, Req 7.3).
const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ParsedClientPayload {
    uploadId: string;
    eventSlug: string;
    filename: string;
    contentType: string;
    size: number;
    // Enqueue-time ISO-8601 upload-intent date (Req 6.6). The client generates
    // it once at enqueue; it is threaded into the signed tokenPayload so
    // onUploadCompleted reconciliation can reconstruct media.date (a NOT NULL
    // column) without fabricating one. Not a secret.
    date: string;
}

/**
 * Sanitize a client-provided filename to a safe basename so the client cannot
 * write arbitrary paths or traverse into another event/user's namespace
 * (Req 5.8). Strips any directory components and disallowed characters; keeps a
 * useful extension. `addRandomSuffix: true` on the token guarantees uniqueness.
 */
function safeBasename(filename: string): string {
    // Take the last path segment only, defeating "../" and absolute paths.
    const base = filename.split(/[\\/]/).pop() ?? '';
    // Allow letters, digits, dot, dash, underscore; replace everything else.
    const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
    return cleaned.length > 0 ? cleaned : 'upload';
}

/**
 * Parse and validate the JSON clientPayload sent by the browser `upload()` call.
 * Returns the parsed payload on success, or a string error message on failure.
 */
function parseClientPayload(raw: string | null): ParsedClientPayload | { error: string } {
    if (!raw) return { error: 'Missing clientPayload' };

    let obj: unknown;
    try {
        obj = JSON.parse(raw);
    } catch {
        return { error: 'Invalid clientPayload' };
    }

    if (typeof obj !== 'object' || obj === null) {
        return { error: 'Invalid clientPayload' };
    }

    const p = obj as Record<string, unknown>;

    const uploadId = p.uploadId;
    const eventSlug = p.eventSlug;
    const filename = p.filename;
    const contentType = p.contentType;
    const size = p.size;
    const date = p.date;

    if (typeof uploadId !== 'string' || !UUID_RE.test(uploadId)) {
        return { error: 'Invalid uploadId' };
    }
    if (typeof eventSlug !== 'string' || eventSlug.length === 0) {
        return { error: 'Invalid eventSlug' };
    }
    if (typeof filename !== 'string' || filename.length === 0) {
        return { error: 'Invalid filename' };
    }
    if (typeof contentType !== 'string' || contentType.length === 0) {
        return { error: 'Invalid contentType' };
    }
    if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) {
        return { error: 'Invalid size' };
    }
    // Enqueue-time upload-intent date (Req 6.6): a non-empty client-generated
    // ISO string. Sanity-check it parses as a date, but do NOT over-constrain the
    // exact format — the client owns the value. Used later to reconstruct
    // media.date during reconciliation without fabrication.
    if (typeof date !== 'string' || date.length === 0 || Number.isNaN(Date.parse(date))) {
        return { error: 'Invalid date' };
    }

    return { uploadId, eventSlug, filename, contentType, size, date };
}

// --- onUploadCompleted reconciliation helpers (Task 5.3, design D1, Req 8.4) --

/**
 * The trusted, server-signed tokenPayload set by THIS route at handshake time
 * (see onBeforeGenerateToken). onUploadCompleted receives it back as an opaque
 * string; this is the ONLY trusted channel for reconciliation metadata (it is
 * NOT client-controlled at completion time).
 */
interface ParsedTokenPayload {
    uploadId: string;
    userId: number;
    eventId: number;
    date: string;
}

/**
 * Parse + validate the server-signed tokenPayload string received by
 * onUploadCompleted. Returns the typed payload or null when missing/unparseable
 * or any field is invalid. A null result means "nothing to reconcile safely" —
 * the caller logs server-side and returns without creating a row.
 */
function parseTokenPayload(raw: string | null | undefined): ParsedTokenPayload | null {
    if (typeof raw !== 'string' || raw.length === 0) return null;

    let obj: unknown;
    try {
        obj = JSON.parse(raw);
    } catch {
        return null;
    }
    if (typeof obj !== 'object' || obj === null) return null;

    const p = obj as Record<string, unknown>;
    const { uploadId, userId, eventId, date } = p;

    if (typeof uploadId !== 'string' || !UUID_RE.test(uploadId)) return null;
    if (typeof userId !== 'number' || !Number.isFinite(userId)) return null;
    if (typeof eventId !== 'number' || !Number.isFinite(eventId)) return null;
    if (typeof date !== 'string' || date.length === 0) return null;

    return { uploadId, userId, eventId, date };
}

/**
 * Verify the completed blob's pathname belongs to the expected server-controlled
 * namespace `events/{eventId}/{uploadId}/...` (mirrors confirm's
 * blobUrlBelongsToEvent semantics). `PutBlobResult.pathname` typically has NO
 * leading slash (e.g. `events/12/<uuid>/name-abc.jpg`), whereas a URL pathname
 * has a leading slash; handle both by stripping any leading slash before the
 * prefix comparison. This prevents a mismatched/forged pathname from creating a
 * row.
 */
function blobPathnameBelongsToUpload(
    pathname: string,
    eventId: number,
    uploadId: string,
): boolean {
    const normalized = pathname.startsWith('/') ? pathname.slice(1) : pathname;
    const expectedPrefix = `events/${eventId}/${uploadId}/`;
    return normalized.startsWith(expectedPrefix);
}

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ 'event-slug': string }> },
): Promise<Response> {
    // --- Minimal parse + auth allowed before the demo check (Req 4.9) --------
    const { 'event-slug': eventSlug } = await params;

    // 1. Authenticate. This is the minimal auth needed to identify the user.
    const auth = verifyRequest(request);
    if (!auth.ok) {
        // 401 (missing/invalid/expired token) or 500 (JWT_SECRET missing) — from
        // the shared helper, no server internals leaked (Req 3.1-3.4).
        return auth.response;
    }
    const user = auth.user;

    // 2. Demo authorization — BEFORE any token issuance / upload-param validation
    //    that could lead to a token (Req 4.1, 4.4, 4.8, 4.9). No client token may
    //    be minted for a demo event or the demo user.
    if (isDemoEvent(eventSlug)) return demoGuardResponse();
    if (isDemoUser(user.email)) return demoGuardResponse(); // defense in depth

    // 3. Validate upload parameters -----------------------------------------
    //    Resolve event_id from the slug (404 if missing) and authorize the user.
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
    } catch {
        // Do not leak DB internals (Req 19.13).
        return new Response('Could not resolve event', { status: 500 });
    }

    // Authorization: mirror the legacy route — any authenticated (non-demo) user
    // may upload to a resolved event; the demo user is already rejected above.
    // (Req 3.7/3.8, 17.3/17.4: no weakening of legacy authorization.)

    try {
        const jsonResponse = await handleUpload({
            request,
            body: (await request.json()) as HandleUploadBody,
            onBeforeGenerateToken: async (pathname, clientPayload) => {
                // Re-assert demo protection inside token generation as a final
                // gate: no token is minted for a demo event/user (Req 4.9).
                if (isDemoEvent(eventSlug) || isDemoUser(user.email)) {
                    throw new Error('demo restriction');
                }

                const parsed = parseClientPayload(clientPayload);
                if ('error' in parsed) {
                    throw new Error(parsed.error);
                }

                // uploadId already validated as UUID in parseClientPayload.
                // eventSlug in payload must match the route param (reject spoofing).
                if (parsed.eventSlug !== eventSlug) {
                    throw new Error('eventSlug mismatch');
                }

                // Early rejection of clearly-invalid content type / size. The
                // AUTHORITATIVE enforcement is allowedContentTypes +
                // maximumSizeInBytes below (Req 19.11/19.12).
                if (!ALLOWED_CONTENT_TYPES.includes(parsed.contentType)) {
                    throw new Error('Only images and videos');
                }
                if (parsed.size > MAX_FILE_SIZE) {
                    throw new Error('File size exceeds 100 MB limit');
                }

                // Server-CONTROLLED pathname enforcement (Req 5.8): the minted
                // token is scoped to the exact `pathname` the client sent, so we
                // must verify that pathname is the expected server-defined,
                // namespaced path `events/{eventId}/{uploadId}/{safeName}`. This
                // prevents the client from writing arbitrary paths or
                // impersonating another event/user. `safeName` is derived from
                // the payload filename (sanitized to a safe basename); the client
                // MUST send exactly this pathname. addRandomSuffix guarantees no
                // collision on the final stored object.
                const safeName = safeBasename(parsed.filename);
                const expectedPathname = `events/${eventId}/${parsed.uploadId}/${safeName}`;
                if (pathname !== expectedPathname) {
                    throw new Error('pathname mismatch');
                }

                return {
                    allowedContentTypes: ALLOWED_CONTENT_TYPES,
                    maximumSizeInBytes: MAX_FILE_SIZE,
                    addRandomSuffix: true,
                    // No secrets in tokenPayload (Req 2.5). `date` is the
                    // enqueue-time upload-intent timestamp (Req 6.6) — not a
                    // secret — carried in this SERVER-SIGNED payload so
                    // onUploadCompleted reconciliation can reconstruct
                    // media.date (NOT NULL) without fabricating one. This is the
                    // ONLY trusted channel for reconciliation metadata.
                    tokenPayload: JSON.stringify({
                        uploadId: parsed.uploadId,
                        userId: user.userId,
                        eventId,
                        date: parsed.date,
                    }),
                };
            },
            onUploadCompleted: async ({ blob, tokenPayload }) => {
                // RECONCILIATION ONLY (Task 5.3, design D1, Req 8.4).
                //
                // PRODUCTION-ONLY: Vercel Blob does NOT fire this webhook against
                // localhost (requires a tunnel), so it never runs in local dev.
                // The client confirm route is the reliable source of truth; this
                // handler is an idempotent reconciliation path that inserts the
                // media row ONLY if it is still missing. It mirrors confirm's
                // INSERT (same columns + ON CONFLICT) so the two paths converge
                // on exactly one row per upload_id (design P1, Req 7.7/7.8).
                //
                // AUTH MODEL: onUploadCompleted has NO request cookie/JWT, so the
                // demo USER cannot be re-checked here. Defense-in-depth relies on:
                //   (a) the handshake already refused a token to demo users AND
                //       demo events (isDemoEvent/isDemoUser above), so a demo user
                //       can never have reached this webhook; and
                //   (b) the explicit isDemoEvent(eventSlug) check below, which
                //       ensures NO row is ever created for a demo event.
                // We deliberately do NOT invent a second auth mechanism here.
                //
                // TRUST MODEL: `tokenPayload` is the SERVER-SIGNED value THIS
                // route set at handshake — it is the trusted source, NOT any
                // client-controlled value. `blob` (PutBlobResult) comes from Blob
                // itself. We still verify the blob exists (head) and that its
                // pathname belongs to the expected `events/{eventId}/{uploadId}/`
                // namespace, and that the route eventSlug resolves to the SAME
                // eventId in the tokenPayload, before inserting.
                //
                // ERROR HANDLING: for EXPECTED no-op conditions (demo event,
                // invalid/missing tokenPayload, pathname/event mismatch, missing
                // blob, missing section) we swallow-and-log and return so Blob
                // does not needlessly retry the webhook. For a genuine transient
                // DB error we allow the throw to propagate so Blob retries. No
                // secrets (BLOB_READ_WRITE_TOKEN / JWT_SECRET) or DB internals are
                // ever exposed; logging is server-side only with non-secret
                // context. Expected no-op conditions `return` (so Blob does not
                // retry); genuine transient DB errors `throw` (so Blob retries).
                {
                    // 1. Parse + validate the trusted, server-signed tokenPayload.
                    const parsed = parseTokenPayload(tokenPayload);
                    if (!parsed) {
                        console.error(
                            'onUploadCompleted: missing/invalid tokenPayload; nothing to reconcile',
                        );
                        return; // no row
                    }

                    // 2. Demo protection (Req 4.3): never create a row for a demo
                    //    event. (Demo users are already blocked at the handshake.)
                    if (isDemoEvent(eventSlug)) {
                        console.error(
                            'onUploadCompleted: demo event, creating no row',
                            eventSlug,
                        );
                        return; // no row
                    }

                    // 3. Verify the route eventSlug resolves to the SAME eventId
                    //    present in the trusted tokenPayload. A mismatch means a
                    //    forged/mismatched context — do NOT create a row.
                    let resolvedEventId: number;
                    try {
                        const eventResult = await pool.query(
                            `SELECT event_id FROM events WHERE event_slug = $1`,
                            [eventSlug],
                        );
                        if (eventResult.rows.length === 0) {
                            console.error(
                                'onUploadCompleted: event not found for slug',
                                eventSlug,
                            );
                            return; // no row
                        }
                        resolvedEventId = eventResult.rows[0].event_id;
                    } catch (dbErr) {
                        // Transient DB error resolving the event — allow retry.
                        console.error(
                            'onUploadCompleted: error resolving event (will allow retry)',
                            dbErr,
                        );
                        throw dbErr;
                    }
                    if (resolvedEventId !== parsed.eventId) {
                        console.error(
                            'onUploadCompleted: eventId mismatch between slug and tokenPayload',
                            { slugEventId: resolvedEventId, tokenEventId: parsed.eventId },
                        );
                        return; // no row
                    }

                    // 4. Ownership/namespace: the completed blob's pathname must
                    //    live under `events/{eventId}/{uploadId}/` (Req security).
                    if (
                        !blobPathnameBelongsToUpload(
                            blob.pathname,
                            parsed.eventId,
                            parsed.uploadId,
                        )
                    ) {
                        console.error(
                            'onUploadCompleted: blob pathname outside expected namespace',
                            { pathname: blob.pathname, eventId: parsed.eventId },
                        );
                        return; // no row
                    }

                    // 5. Verify the blob ACTUALLY exists before inserting (P2/P3,
                    //    Req 8.6: no row if the original upload did not succeed).
                    //    `head` uses BLOB_READ_WRITE_TOKEN from the server env
                    //    (never exposed / logged).
                    try {
                        await head(blob.url);
                    } catch (headErr) {
                        if (headErr instanceof BlobNotFoundError) {
                            console.error(
                                'onUploadCompleted: blob not found, creating no row',
                            );
                            return; // no row
                        }
                        // Other head error: do not create a row and do not throw
                        // internals — let the webhook be retried by returning.
                        console.error(
                            'onUploadCompleted: error verifying blob existence',
                            headErr,
                        );
                        return; // no row
                    }

                    // 6. Resolve the default 'Sin clasificar' section (same query
                    //    confirm uses). No EXIF here, so use the default section.
                    let sectionId: number;
                    try {
                        const fallback = await pool.query(
                            `SELECT section_id FROM sections WHERE event_id = $1 AND section_name = 'Sin clasificar' LIMIT 1`,
                            [parsed.eventId],
                        );
                        if (fallback.rows.length === 0) {
                            console.error(
                                'onUploadCompleted: default section not found for event',
                                parsed.eventId,
                            );
                            return; // no row (cannot insert with an invalid section)
                        }
                        sectionId = fallback.rows[0].section_id;
                    } catch (dbErr) {
                        // Transient DB error resolving the section — allow retry.
                        console.error(
                            'onUploadCompleted: error finding section (will allow retry)',
                            dbErr,
                        );
                        throw dbErr;
                    }

                    // 7. IDEMPOTENT INSERT — mirrors confirm's INSERT exactly
                    //    (same columns + ON CONFLICT (upload_id) DO NOTHING). If
                    //    the client confirm already created the row, this inserts
                    //    NOTHING (no duplicate) thanks to the media_upload_id_key
                    //    partial unique index — a safe no-op (design P1, Req 7.8).
                    //    date = tokenPayload.date (the trustworthy enqueue-time
                    //    date — NEVER fabricated, NEVER now()). blurhash = null:
                    //    reconciliation has no client blurhash; the column is
                    //    nullable, so we do NOT invent one.
                    //
                    //    NOTE: this intentionally duplicates confirm's small
                    //    INSERT inline (constraint: do not import/modify confirm's
                    //    route module). Both converge via ON CONFLICT.
                    try {
                        const insertResult = await pool.query(
                            `INSERT INTO media (content, type, date, user_id, section_id, event_id, blurhash, upload_id)
                             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                             ON CONFLICT (upload_id) WHERE upload_id IS NOT NULL DO NOTHING`,
                            [
                                blob.url,
                                blob.contentType,
                                parsed.date,
                                parsed.userId,
                                sectionId,
                                parsed.eventId,
                                null,
                                parsed.uploadId,
                            ],
                        );
                        if ((insertResult.rowCount ?? 0) === 0) {
                            // Row already existed (confirm won the race) — no-op.
                            console.error(
                                'onUploadCompleted: media row already existed; reconciliation no-op',
                                parsed.uploadId,
                            );
                        }
                    } catch (dbErr) {
                        // Genuine transient DB failure — allow Blob to retry the
                        // webhook by rethrowing. No internals surface to a client
                        // (there is none); logged server-side only.
                        console.error(
                            'onUploadCompleted: idempotent insert failed (will allow retry)',
                            dbErr,
                        );
                        throw dbErr;
                    }
                }
            },
        });

        // Success invariant (Req 2.2, user requirement 8): a successful
        // authorization must return exactly one valid client token. If token
        // generation somehow succeeded without producing a token, treat it as a
        // server error rather than returning a misleading success.
        if (
            jsonResponse.type === 'blob.generate-client-token' &&
            !jsonResponse.clientToken
        ) {
            return new Response('Could not issue upload token', { status: 500 });
        }

        return Response.json(jsonResponse);
    } catch (error) {
        // Map handshake failures to safe, generic responses (Req 19.13: no
        // internals, no JWT secret, no authorization detail leaked).
        const message = error instanceof Error ? error.message : '';

        if (message === 'demo restriction') return demoGuardResponse();
        if (message === 'Only images and videos') {
            return Response.json({ error: 'Only images and videos' }, { status: 400 });
        }
        if (message === 'File size exceeds 100 MB limit') {
            return Response.json(
                { error: 'File size exceeds 100 MB limit' },
                { status: 400 },
            );
        }
        if (
            message === 'Missing clientPayload' ||
            message === 'Invalid clientPayload' ||
            message === 'Invalid uploadId' ||
            message === 'Invalid eventSlug' ||
            message === 'Invalid filename' ||
            message === 'Invalid contentType' ||
            message === 'Invalid size' ||
            message === 'Invalid date' ||
            message === 'eventSlug mismatch' ||
            message === 'pathname mismatch'
        ) {
            return Response.json({ error: 'Invalid upload request' }, { status: 400 });
        }

        // Unknown failure: generic 400 (handleUpload rejects on malformed bodies)
        // with no server internals surfaced.
        return Response.json({ error: 'Upload token request failed' }, { status: 400 });
    }
}
