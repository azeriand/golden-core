// Poster_Worker one-time backfill command (Requirement 13).
//
// PURPOSE: enqueue a Poster_Job for every pre-existing video Media_Row that has
// no poster yet, so videos uploaded BEFORE this feature shipped also receive
// posters. This is a one-shot operation, run via a Railway one-off task or
// `node worker/dist/backfill.js` (the worker package's `backfill` script).
//
// IDEMPOTENCY-FIRST: the whole backfill is a SINGLE set-based INSERT ... SELECT
// guarded by `ON CONFLICT (media_id) DO NOTHING`. That one statement:
//
//   1. Selects ONLY videos (`type LIKE 'video/%'`) — the LIVE `media.type`
//      column is a MIME string beginning with `video/` (see design.md
//      "Important schema note"; the requirements' `media_type = 'video'` maps to
//      this predicate on the deployed schema) (Req 13.2).
//   2. Selects ONLY rows with no poster yet (`poster_url IS NULL`) (Req 13.1).
//   3. Relies on the unique index poster_jobs_media_id_key + ON CONFLICT DO
//      NOTHING so a media row that ALREADY has a job is skipped, and rerunning
//      the whole backfill creates NO duplicate jobs (Req 13.1 "no existing job",
//      13.3 "no duplicates on rerun") — the same atomic dedupe primitive the
//      enqueue paths use.
//
// It only ever INSERTs into poster_jobs; it never reads-for-write, updates, or
// otherwise touches `media` or its `content` value, so every existing Media_Row
// is left completely unchanged (Req 13.4).
//
// SECRETS: this module handles no secret directly. The executor it queries is
// the worker Pool constructed in db.ts from DATABASE_URL (env-only); nothing
// here logs or returns that value (Requirements 14.2, 14.3, 14.4).

import type { Pool, PoolClient } from 'pg';
import { getPool, closePool } from './db.js';
import { logger } from './logger.js';

/**
 * Minimal executor type so the backfill runs against the shared worker Pool OR a
 * transaction client (both expose `.query` with the same signature). This is the
 * same injectable-executor shape used by the queue and enqueue helpers, and it
 * is what makes `runBackfill` unit-testable with an in-memory model of the
 * INSERT ... SELECT ... ON CONFLICT DO NOTHING semantics.
 */
type Executor = Pick<Pool | PoolClient, 'query'>;

// The single, set-based, idempotent backfill statement. Kept as a module-level
// constant so the test can assert against the exact SQL contract if desired.
//
// INSERT ... SELECT enqueues one pending job per matching media row in a single
// round trip (no per-row work). New jobs are created with status = 'pending',
// attempts = 0, and run_after = now() so they are immediately eligible for the
// worker to claim — matching the enqueue helper's job shape.
const BACKFILL_SQL = `
    INSERT INTO poster_jobs (media_id, status, attempts, run_after, created_at, updated_at)
    SELECT m.media_id, 'pending', 0, now(), now(), now()
    FROM media m
    WHERE m.type LIKE 'video/%'          -- videos only (Req 13.2)
      AND m.poster_url IS NULL           -- no poster yet (Req 13.1)
    ON CONFLICT (media_id) DO NOTHING    -- skip existing jobs / no dupes (Req 13.1, 13.3)
`;

/**
 * Run the one-time backfill against the given executor.
 *
 * Enqueues a pending Poster_Job for every video Media_Row with a NULL
 * `poster_url` that does not already have a job. Because the whole operation is
 * one `INSERT ... SELECT ... ON CONFLICT (media_id) DO NOTHING`, running it once
 * or many times yields the same final set of jobs (Req 13.3), it only inserts
 * for videos with no poster (Req 13.1, 13.2), and it never modifies `media` or
 * `content` (Req 13.4).
 *
 * Returns the number of NEW jobs actually inserted (rows that did not conflict)
 * so a caller can log/report how many videos were newly enqueued. Rerunning on
 * an already-backfilled database therefore returns 0.
 */
export async function runBackfill(db: Executor = getPool()): Promise<number> {
    const result = await db.query(BACKFILL_SQL);
    // pg reports the number of rows the INSERT actually created; ON CONFLICT
    // DO NOTHING excludes conflicting rows from this count, so this is exactly
    // the count of newly-enqueued jobs. Some drivers may report null -> treat as 0.
    return result.rowCount ?? 0;
}

/**
 * CLI entry point: run the backfill once against the shared worker Pool, log a
 * secret-free summary, close the Pool, and exit with a non-zero code on failure
 * so a Railway one-off task surfaces the error. Only executes when this module
 * is run as the process entry (`node dist/backfill.js`), never on import (so the
 * unit test can import `runBackfill` without triggering a real DB run).
 */
export async function main(): Promise<void> {
    try {
        const enqueued = await runBackfill();
        logger.info('backfill.complete', { enqueued });
    } catch (err) {
        logger.info('backfill.failed', { error: String(err instanceof Error ? err.name : 'error') });
        process.exitCode = 1;
    } finally {
        await closePool();
    }
}

// Detect "run as entry point" under NodeNext ESM. import.meta.url is the module
// URL; process.argv[1] is the invoked script path. When they refer to the same
// file, this module was executed directly rather than imported.
const isEntryPoint = (() => {
    try {
        const invoked = process.argv[1];
        if (!invoked) return false;
        return import.meta.url === new URL(`file://${invoked}`).href
            || import.meta.url.endsWith(invoked);
    } catch {
        return false;
    }
})();

if (isEntryPoint) {
    void main();
}
