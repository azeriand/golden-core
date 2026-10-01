-- Migration: Add media visibility control and moderation audit trail.
-- Purpose: Enable administrators to hide media items from public view without
--          permanently deleting them. This migration extends the media table with
--          visibility state (is_hidden, hidden_at, hidden_by) and creates a
--          media_moderation_log table to maintain an audit trail of all hide/unhide
--          actions with optional moderation reasons.
-- Requirements: 1.2, 1.3, 1.4, 4.1, 4.2
-- Notes: Additive and reversible. All new columns on media are nullable or have
--        defaults (is_hidden defaults to false), so ALL existing media rows stay
--        valid and remain visible (is_hidden = false). No existing media column,
--        constraint, index, or data is modified. The CHECK constraint ensures
--        hidden_by and hidden_at are only set when is_hidden is true.
--        Runs as a single transaction; a failure applies nothing partial.

-- ── Step 1: Visibility control columns on media ───────────────────────────────
-- is_hidden: Boolean flag indicating visibility state (default: false = visible)
-- hidden_at: Timestamp when the media was hidden (NULL if visible)
-- hidden_by: Foreign key to users.user_id of the admin who hid it (NULL if visible)
ALTER TABLE public.media
    ADD COLUMN is_hidden boolean NOT NULL DEFAULT false,
    ADD COLUMN hidden_at timestamptz,
    ADD COLUMN hidden_by integer REFERENCES public.users(user_id);

-- ── Step 2: Indexes for media visibility ──────────────────────────────────────
-- B-tree index on is_hidden for fast filtering in public queries
-- (most queries will filter WHERE is_hidden = false)
CREATE INDEX idx_media_is_hidden ON public.media(is_hidden);

-- Partial index on hidden_at for admin queries sorting by when items were hidden
-- (only indexes rows where is_hidden = true for efficiency)
CREATE INDEX idx_media_hidden_at ON public.media(hidden_at)
    WHERE is_hidden = true;

-- ── Step 3: CHECK constraint for consistency ──────────────────────────────────
-- Ensures that hidden_by and hidden_at are only set when is_hidden is true.
-- Prevents inconsistent states like is_hidden=false with hidden_by populated.
ALTER TABLE public.media
    ADD CONSTRAINT check_hidden_by_consistency
    CHECK (
        (is_hidden = false AND hidden_by IS NULL AND hidden_at IS NULL)
        OR (is_hidden = true AND hidden_by IS NOT NULL AND hidden_at IS NOT NULL)
    );

-- ── Step 4: Moderation log table ──────────────────────────────────────────────
-- Audit trail for all media visibility changes. Each row records a single
-- hide or unhide action with the admin who performed it, the timestamp, and
-- an optional moderation reason (max 500 characters).
CREATE TABLE public.media_moderation_log (
    log_id serial PRIMARY KEY,
    media_id integer NOT NULL REFERENCES public.media(media_id) ON DELETE CASCADE,
    admin_id integer NOT NULL REFERENCES public.users(user_id),
    action varchar(10) NOT NULL CHECK (action IN ('hide', 'unhide')),
    reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT reason_length CHECK (length(reason) <= 500)
);

-- ── Step 5: Indexes for moderation log ────────────────────────────────────────
-- Index on media_id for quick lookup of moderation history per media item
CREATE INDEX idx_moderation_log_media_id
    ON public.media_moderation_log(media_id);

-- Index on created_at for chronological queries of moderation actions
CREATE INDEX idx_moderation_log_created_at
    ON public.media_moderation_log(created_at DESC);

-- ── Rollback ──────────────────────────────────────────────────────────────────
-- Reverse the steps in reverse order. Restores the schema to its pre-migration
-- state. Additive/reversible — no existing media column, constraint, index, or
-- data is modified by the forward migration, only additions are made:
--
-- DROP INDEX  IF EXISTS public.idx_moderation_log_created_at;
-- DROP INDEX  IF EXISTS public.idx_moderation_log_media_id;
-- DROP TABLE  IF EXISTS public.media_moderation_log;
-- ALTER TABLE public.media DROP CONSTRAINT IF EXISTS check_hidden_by_consistency;
-- DROP INDEX  IF EXISTS public.idx_media_hidden_at;
-- DROP INDEX  IF EXISTS public.idx_media_is_hidden;
-- ALTER TABLE public.media DROP COLUMN IF EXISTS hidden_by;
-- ALTER TABLE public.media DROP COLUMN IF EXISTS hidden_at;
-- ALTER TABLE public.media DROP COLUMN IF EXISTS is_hidden;
