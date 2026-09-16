-- Migration: Add media.poster_url and the public.poster_jobs queue table.
-- Purpose: Enable asynchronous, worker-generated video posters. media.poster_url
--          records the generated poster's Blob URL (NULL = none yet). poster_jobs
--          is a durable, Postgres-backed job queue (no new managed queue product):
--          one job per media_id (unique index) enables idempotent enqueue via
--          ON CONFLICT (media_id) DO NOTHING, mirroring media_upload_id_key.
-- Requirements: 1.1-1.7, 2.1-2.6, 5.2, 16.4
-- Notes: Additive and reversible. poster_url is nullable with no default, so all
--        existing media rows stay valid (poster_url NULL, interpreted as "no
--        poster ready yet"). No existing column, constraint, index, or data on
--        public.media is modified (Req 1.4). Runs as a single unit; a failure
--        applies nothing partial (Req 1.7).
--        The LIVE "is this a video?" column is `type` (a MIME string beginning
--        with 'video/', e.g. 'video/mp4'), NOT `media_type`. schema.sql is a
--        stale pg_dump (same staleness recorded in 002_add_upload_id_column.sql,
--        audit Finding 1.9); this migration and the enqueue/backfill logic target
--        the deployed `type` column.

-- 1. Additive nullable column on media (Req 1.1, 1.3, 1.6).
ALTER TABLE public.media
  ADD COLUMN poster_url text;

-- 2. Durable job queue (Req 2.1, 2.2, 2.3). Uses the existing Neon Postgres
--    database as the sole poster-job store — no managed queue product (Req 2.5,
--    2.6). attempts + updated_at retain processing history for observability
--    (Req 16.4).
CREATE TABLE public.poster_jobs (
    id          bigserial   PRIMARY KEY,
    media_id    integer     NOT NULL REFERENCES public.media(media_id),
    status      text        NOT NULL DEFAULT 'pending',
    attempts    integer     NOT NULL DEFAULT 0,
    run_after   timestamptz NOT NULL DEFAULT now(),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT poster_jobs_status_check
        CHECK (status IN ('pending', 'processing', 'done', 'failed'))
);

-- 3. At most one job per media_id — the atomic dedupe primitive that backs
--    ON CONFLICT (media_id) DO NOTHING for idempotent enqueue, mirroring
--    media_upload_id_key (Req 2.4, 5.2).
CREATE UNIQUE INDEX poster_jobs_media_id_key
    ON public.poster_jobs (media_id);

-- 4. Claim-scan support: pending jobs due to run, cheapest first (backs the
--    worker's SELECT ... FOR UPDATE SKIP LOCKED claim query).
CREATE INDEX poster_jobs_claim_idx
    ON public.poster_jobs (status, run_after);

-- Rollback (reverse order: drop the queue table's indexes, then the table, then
-- the media column). Restores the schema to its pre-migration state (Req 1.5,
-- 1.7). Additive/reversible — no existing media column, constraint, index, or
-- data is touched:
-- DROP INDEX IF EXISTS public.poster_jobs_claim_idx;
-- DROP INDEX IF EXISTS public.poster_jobs_media_id_key;
-- DROP TABLE IF EXISTS public.poster_jobs;
-- ALTER TABLE public.media DROP COLUMN IF EXISTS poster_url;
