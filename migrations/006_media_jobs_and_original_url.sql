-- Migration: Add media.original_url and introduce the media_jobs queue.
-- Purpose: (1) Preserve the untouched original Blob URL per media row so the
--          app can always fall back to the original and later deliver it via
--          WeTransfer-style export. (2) Generalise the existing poster_jobs queue
--          into a unified media_jobs queue that supports three kinds of work —
--          poster, image derivative, and video transcode — each tracked
--          independently per media row.
-- Requirements: 1.5, 5.1, 5.5, 8.5, 9.3, 9.4
-- Notes: Additive and reversible. original_url is nullable with no default, so
--        ALL existing media rows stay valid (original_url NULL is interpreted as
--        "content is the only version — no separate original recorded"). No
--        existing media column, constraint, index, or data is modified (Req 9.3).
--        schema.sql is a stale pg_dump (same staleness recorded in migrations
--        002/004/005); this migration targets the deployed, migration-driven LIVE
--        table, not schema.sql.
--        Runs as a single transaction; a failure applies nothing partial (Req 8.5).

-- ── Step 1: original_url on media ────────────────────────────────────────────
-- Nullable text column. NULL on legacy rows = "content is the only version".
-- New uploads set this to the same Blob URL as content at creation time; the
-- worker never overwrites it (Req 1.3, 1.5).
ALTER TABLE public.media
    ADD COLUMN original_url text;

-- ── Step 2: media_jobs queue ──────────────────────────────────────────────────
-- Generalises poster_jobs to support multiple job kinds per media row. Each
-- (media_id, kind) pair is unique, enabling idempotent enqueue via
-- ON CONFLICT (media_id, kind) DO NOTHING — mirroring media_upload_id_key and
-- the existing poster_jobs_media_id_key (Req 5.1, 5.2).
--
-- kind is constrained to the three known values: 'poster', 'image', 'video'.
-- New kinds can be added later by extending the CHECK constraint.
CREATE TABLE public.media_jobs (
    id          bigserial   PRIMARY KEY,
    media_id    integer     NOT NULL REFERENCES public.media(media_id),
    kind        text        NOT NULL,
    status      text        NOT NULL DEFAULT 'pending',
    attempts    integer     NOT NULL DEFAULT 0,
    run_after   timestamptz NOT NULL DEFAULT now(),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT media_jobs_kind_check
        CHECK (kind IN ('poster', 'image', 'video')),
    CONSTRAINT media_jobs_status_check
        CHECK (status IN ('pending', 'processing', 'done', 'failed'))
);

-- ── Step 3: indexes ───────────────────────────────────────────────────────────
-- At most one job per (media_id, kind) — the atomic dedupe primitive for
-- ON CONFLICT (media_id, kind) DO NOTHING (Req 5.1, 5.2).
CREATE UNIQUE INDEX media_jobs_media_id_kind_key
    ON public.media_jobs (media_id, kind);

-- Claim-scan support: pending jobs due to run, cheapest first (backs the
-- worker's SELECT ... FOR UPDATE SKIP LOCKED claim query).
CREATE INDEX media_jobs_claim_idx
    ON public.media_jobs (status, run_after);

-- ── Step 4: migrate existing poster_jobs rows ─────────────────────────────────
-- Copy all existing poster_jobs rows into media_jobs as kind='poster', preserving
-- media_id, status, attempts, run_after, created_at, and updated_at so no
-- in-flight or pending poster work is lost (Req 5.5, 9.4).
-- poster_jobs itself is left in place so any currently-deployed worker code that
-- still queries poster_jobs keeps working; removing it is a follow-on migration
-- once all callers are updated.
INSERT INTO public.media_jobs (media_id, kind, status, attempts, run_after, created_at, updated_at)
SELECT media_id, 'poster', status, attempts, run_after, created_at, updated_at
FROM public.poster_jobs
ON CONFLICT (media_id, kind) DO NOTHING;

-- ── Rollback ──────────────────────────────────────────────────────────────────
-- Reverse the steps in reverse order. Restores the schema to its pre-migration
-- state. Additive/reversible — no existing media column, constraint, index, or
-- data is modified by the forward migration, only additions are made:
--
-- DELETE FROM public.media_jobs WHERE kind = 'poster';   -- remove migrated rows
-- DROP INDEX  IF EXISTS public.media_jobs_claim_idx;
-- DROP INDEX  IF EXISTS public.media_jobs_media_id_kind_key;
-- DROP TABLE  IF EXISTS public.media_jobs;
-- ALTER TABLE public.media DROP COLUMN IF EXISTS original_url;
