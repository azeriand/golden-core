// Idempotent media-job enqueue helper.
//
// Generalises lib/poster-jobs.ts from a single poster queue to a unified
// media_jobs queue that supports three job kinds per media row: 'poster',
// 'image', and 'video'. Each (media_id, kind) pair is tracked independently
// so retry/backoff operates per kind and a failure in one kind never blocks
// another (Req 5.3, 5.4).
//
// Idempotency is enforced by the DATABASE: the unique index
// media_jobs_media_id_kind_key makes `ON CONFLICT (media_id, kind) DO NOTHING`
// the atomic dedupe primitive. This mirrors the media_upload_id_key +
// `ON CONFLICT (upload_id) DO NOTHING` pattern the confirm/webhook routes
// already use for idempotent media creation, and the poster_jobs_media_id_key
// pattern in the original poster queue (Req 5.1, 5.2).
//
// Follows the same pure, executor-taking style as lib/poster-jobs.ts.

import type { Pool, PoolClient } from 'pg';

// A minimal executor type so the helper works with the shared pool OR a
// transaction client. Both `Pool` and `PoolClient` expose `.query` with the
// same signature, so accepting the intersection of their `query` method lets a
// caller pass either one (e.g. the default pool, or a client mid-transaction).
type Executor = Pick<Pool | PoolClient, 'query'>;

/**
 * The three kinds of work a media row can have enqueued. Each kind for a given
 * media row is tracked as an independent job in media_jobs, with its own
 * status, attempts, and backoff. A failure of one kind does not block another
 * (Req 5.3, 5.4).
 */
export type MediaJobKind = 'poster' | 'image' | 'video';

/**
 * Idempotently enqueue a job of the given kind for a media row.
 *
 * Idempotency is enforced by the DATABASE: the unique index on
 * (media_id, kind) makes `ON CONFLICT (media_id, kind) DO NOTHING` the atomic
 * dedupe primitive (mirrors the media_upload_id_key and poster_jobs_media_id_key
 * patterns). Calling this once or many times for the same (mediaId, kind) pair
 * yields exactly one job (Req 5.1, 5.2).
 *
 * The new job is created with status = 'pending', attempts = 0, and
 * run_after = now() so it is immediately eligible for claiming.
 *
 * Returns true if a NEW job row was inserted, false if one already existed
 * (conflict). Callers use the boolean only for logging; correctness does not
 * depend on it.
 *
 * This function NEVER throws for the "already exists" case (that is a silent
 * no-op via ON CONFLICT DO NOTHING). It DOES surface a genuine database error
 * to the caller, which decides how to handle it:
 *   - Confirm route swallows-and-logs: media creation already succeeded and
 *     must not be failed by an enqueue error.
 *   - Webhook path rethrows so Vercel Blob retries the webhook.
 */
export async function enqueueMediaJob(
    db: Executor,
    mediaId: number,
    kind: MediaJobKind,
): Promise<boolean> {
    const result = await db.query(
        `INSERT INTO media_jobs (media_id, kind, status, attempts, run_after, created_at, updated_at)
         VALUES ($1, $2, 'pending', 0, now(), now(), now())
         ON CONFLICT (media_id, kind) DO NOTHING`,
        [mediaId, kind],
    );
    // rowCount is 1 when a new job was inserted, 0 on conflict (already exists).
    // Some drivers may report null for rowCount; treat that as "no insert".
    return (result.rowCount ?? 0) > 0;
}

/**
 * True when a media row's stored type denotes a video. The LIVE column is
 * `type`, a MIME string (e.g. 'video/mp4'); videos begin with 'video/'. This
 * predicate is the single source of truth for "is this a video?" so both
 * enqueue paths and any backfill agree (mirrors the same function in
 * lib/poster-jobs.ts — callers should migrate to this one).
 */
export function isVideoType(type: string | null | undefined): boolean {
    return typeof type === 'string' && type.startsWith('video/');
}

/**
 * True when a media row's stored type denotes an image. The LIVE column is
 * `type`, a MIME string (e.g. 'image/jpeg'); images begin with 'image/'.
 */
export function isImageType(type: string | null | undefined): boolean {
    return typeof type === 'string' && type.startsWith('image/');
}
