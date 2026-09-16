// Idempotent poster-job enqueue helper.
//
// A video media row must have exactly one poster job, no matter how many times
// (or from how many paths) enqueue is attempted. This module is the single,
// shared write contract for the poster_jobs queue so BOTH production enqueue
// paths behave identically:
//   - the same-session confirm route (app/api/event/[event-slug]/media/confirm)
//   - the production onUploadCompleted webhook (media/upload-token)
// and so the one-time backfill agrees with them on "is this a video?".
//
// Idempotency is enforced by the DATABASE, not by application logic: the unique
// index on poster_jobs.media_id makes `ON CONFLICT (media_id) DO NOTHING` the
// atomic dedupe primitive. This mirrors the media_upload_id_key +
// `ON CONFLICT (upload_id) DO NOTHING` pattern the confirm/webhook routes
// already use for idempotent media creation.
//
// Follows the pure, heavily-commented style of lib/section-match.ts: a small
// helper that takes a pg executor and returns a value, with no hidden state.

import type { Pool, PoolClient } from 'pg';

// A minimal executor type so the helper works with the shared pool OR a
// transaction client. Both `Pool` and `PoolClient` expose `.query` with the
// same signature, so accepting the intersection of their `query` method lets a
// caller pass either one (e.g. the default pool, or a client mid-transaction).
type Executor = Pick<Pool | PoolClient, 'query'>;

/**
 * Idempotently enqueue a poster job for a video media row.
 *
 * Idempotency is enforced by the DATABASE: the unique index on
 * poster_jobs.media_id makes `ON CONFLICT (media_id) DO NOTHING` the atomic
 * dedupe primitive (mirrors the media_upload_id_key pattern used by the
 * confirm/webhook routes). Calling this once or many times for the same
 * media_id yields exactly one job (Req 5.1, 5.2, 5.3).
 *
 * The new job is created with status = 'pending', attempts = 0, and
 * run_after = now() so it is immediately eligible for claiming (Req 3.4).
 *
 * Returns true if a NEW job row was inserted, false if one already existed
 * (conflict). Callers use the boolean only for logging; correctness does not
 * depend on it.
 *
 * This function NEVER throws for the "already exists" case (that is a silent
 * no-op via ON CONFLICT DO NOTHING). It DOES surface a genuine database error
 * to the caller, which decides how to handle it:
 *   - Confirm_Route swallows-and-logs (Req 3.5): media creation already
 *     succeeded and must not be failed by an enqueue error.
 *   - Webhook_Path rethrows so Vercel Blob retries the webhook (Req 4.4).
 */
export async function enqueuePosterJob(
    db: Executor,
    mediaId: number,
): Promise<boolean> {
    const result = await db.query(
        `INSERT INTO poster_jobs (media_id, status, attempts, run_after, created_at, updated_at)
         VALUES ($1, 'pending', 0, now(), now(), now())
         ON CONFLICT (media_id) DO NOTHING`,
        [mediaId],
    );
    // rowCount is 1 when a new job was inserted, 0 on conflict (already exists).
    // Some drivers may report null for rowCount; treat that as "no insert".
    return (result.rowCount ?? 0) > 0;
}

/**
 * True when a media row's stored type denotes a video. The LIVE column is
 * `type`, a MIME string (e.g. 'video/mp4'); videos begin with 'video/'. This
 * predicate is the single source of truth for "should we enqueue?" so both
 * enqueue paths and the backfill agree (Req 3.2, 4.3, 13.2).
 */
export function isVideoType(type: string | null | undefined): boolean {
    return typeof type === 'string' && type.startsWith('video/');
}
