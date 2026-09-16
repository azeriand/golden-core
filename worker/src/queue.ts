// Poster_Worker queue state machine.
//
// This module owns the SQL that drives the Poster_Job lifecycle in the
// public.poster_jobs table (the durable, Postgres-backed queue -- no managed
// queue product, Requirement 2.5/2.6). It is the single place that transitions a
// job between the four Job_Status values (pending -> processing -> done/failed,
// with reclaim/retry returning failed-but-retryable work to pending).
//
// The four exported operations map directly to the design's queue contract:
//   - claimJobs(limit)          claim due pending jobs atomically (Req 7.1, 7.2, 7.5)
//   - completeJob(id)           mark a job done after poster_url is written (Req 8.5)
//   - failJob(id, attempts)     increment attempts; retry-with-backoff or fail (Req 9.1-9.5)
//   - reclaimStaleProcessing(t) return stuck 'processing' jobs to 'pending' (Req 10.2)
//
// SECRETS: this module only ever handles ids, counts, and statuses. It never
// reads, returns, or logs DATABASE_URL / BLOB_READ_WRITE_TOKEN (Requirements
// 14.2, 14.3, 14.4) -- the Pool it queries is constructed in db.ts from env.

import type { Pool, PoolClient } from 'pg';
import { getPool } from './db.js';

/**
 * Minimal executor type so every queue operation works against the shared worker
 * Pool OR a transaction client (both expose `.query` with the same signature).
 * Callers may omit it, in which case the shared singleton Pool is used.
 */
type Executor = Pick<Pool | PoolClient, 'query'>;

/**
 * A Poster_Job row as claimed from the queue. Mirrors the columns returned by the
 * claim statement's RETURNING clause. `run_after` is serialized by `pg` as an ISO
 * timestamp string. `status` is constrained to the four lifecycle values by the
 * table's CHECK constraint (Requirement 2.3).
 */
export interface PosterJob {
  id: number;
  media_id: number;
  status: 'pending' | 'processing' | 'done' | 'failed';
  attempts: number;
  run_after: string; // ISO timestamp
}

/**
 * Claim up to `limit` due `pending` jobs, flipping them to `processing` in a
 * SINGLE atomic statement (Requirements 7.1, 7.2, 7.5).
 *
 * The inner SELECT chooses only jobs that are `pending` AND due
 * (`run_after <= now()`), ordered cheapest-first by `run_after`, and locks the
 * chosen rows with `FOR UPDATE SKIP LOCKED`. SKIP LOCKED means a row already
 * locked by a concurrently-polling worker is silently skipped, so a given job is
 * claimed by at most one worker per poll cycle even under concurrent polling
 * (Req 7.1, 7.5). `failed` jobs are never selected (the `status = 'pending'`
 * filter), so they are never reclaimed (Req 9.5).
 *
 * The outer UPDATE transitions the claimed rows to `processing` and stamps
 * `updated_at = now()` BEFORE any frame extraction begins (Req 7.2), and returns
 * the claimed rows so the caller can dispatch them for processing.
 *
 * A non-positive `limit` claims nothing (an empty batch), so a caller with no
 * free capacity can call this harmlessly.
 */
export async function claimJobs(
  limit: number,
  db: Executor = getPool(),
): Promise<PosterJob[]> {
  if (!Number.isFinite(limit) || limit <= 0) {
    return [];
  }
  const result = await db.query<PosterJob>(
    `UPDATE poster_jobs
     SET status = 'processing', updated_at = now()
     WHERE id IN (
         SELECT id FROM poster_jobs
         WHERE status = 'pending' AND run_after <= now()
         ORDER BY run_after
         FOR UPDATE SKIP LOCKED
         LIMIT $1
     )
     RETURNING id, media_id, status, attempts, run_after`,
    [limit],
  );
  return result.rows;
}

/**
 * Mark a job `done`. Called only after the poster image has been uploaded and
 * the media row's `poster_url` written, so a `done` job always corresponds to a
 * non-null `poster_url` (Requirement 8.5, upheld together with the pipeline in
 * process-job.ts). Stamps `updated_at` for observability (Req 16.4).
 */
export async function completeJob(
  jobId: number,
  db: Executor = getPool(),
): Promise<void> {
  await db.query(
    `UPDATE poster_jobs
     SET status = 'done', updated_at = now()
     WHERE id = $1`,
    [jobId],
  );
}

/**
 * Handle a processing failure for a job (Requirement 9).
 *
 * `attempts` is the job's attempt count BEFORE this failure (the value read when
 * the job was claimed). This single statement:
 *   - increments `attempts` by exactly one on every failure (Req 9.1);
 *   - when the incremented count is still below `maxAttempts`, returns the job to
 *     `pending` with a strictly-future `run_after` computed by exponential
 *     backoff `base * 2^attempts` seconds, which grows as `attempts` grows
 *     (Req 9.2, 9.3);
 *   - when the incremented count reaches `maxAttempts`, marks the job `failed`
 *     and LEAVES `run_after` unchanged so a terminal job carries no misleading
 *     future schedule (Req 9.4). `failed` jobs are never re-claimed (Req 9.5).
 *
 * The backoff exponent uses the pre-increment `attempts` so the first retry waits
 * `base * 2^0 = base` seconds, the second `base * 2^1`, and so on. `maxAttempts`
 * and `base` come from the worker config so both are env-configurable (Req 9.6).
 */
export async function failJob(
  jobId: number,
  attempts: number,
  maxAttempts: number,
  backoffBaseSeconds: number,
  db: Executor = getPool(),
): Promise<void> {
  await db.query(
    `UPDATE poster_jobs
     SET attempts = attempts + 1,
         status = CASE WHEN attempts + 1 >= $2 THEN 'failed' ELSE 'pending' END,
         run_after = CASE WHEN attempts + 1 >= $2
                          THEN run_after
                          ELSE now() + ($3 * power(2, attempts)) * interval '1 second'
                     END,
         updated_at = now()
     WHERE id = $1`,
    [jobId, maxAttempts, backoffBaseSeconds],
  );
}

/**
 * Reclaim stale `processing` jobs whose `updated_at` is older than
 * `timeoutSeconds`, returning them to `pending` so a worker that crashed
 * mid-processing does not strand its claimed jobs (Requirement 10.2). Because the
 * job goes back to `pending` (not `failed`), it becomes eligible for a normal
 * claim on the next cycle. Returns the number of jobs reclaimed for logging.
 */
export async function reclaimStaleProcessing(
  timeoutSeconds: number,
  db: Executor = getPool(),
): Promise<number> {
  const result = await db.query(
    `UPDATE poster_jobs
     SET status = 'pending', updated_at = now()
     WHERE status = 'processing'
       AND updated_at < now() - ($1 * interval '1 second')`,
    [timeoutSeconds],
  );
  return result.rowCount ?? 0;
}
