-- Migration: Add media visibility control.
-- Allows administrators to hide media items from public view without deleting them.
-- Requirements: 1.2, 1.3, 1.4
-- Notes: Additive and reversible. is_hidden defaults to false so all existing rows
--        remain visible. Runs in a single transaction.

-- ── Step 1: Visibility columns on media ──────────────────────────────────────
ALTER TABLE public.media
    ADD COLUMN is_hidden boolean NOT NULL DEFAULT false,
    ADD COLUMN hidden_at timestamptz,
    ADD COLUMN hidden_by integer REFERENCES public.users(user_id);

-- ── Step 2: Indexes ───────────────────────────────────────────────────────────
CREATE INDEX idx_media_is_hidden ON public.media(is_hidden);

CREATE INDEX idx_media_hidden_at ON public.media(hidden_at)
    WHERE is_hidden = true;

-- ── Step 3: Consistency constraint ───────────────────────────────────────────
ALTER TABLE public.media
    ADD CONSTRAINT check_hidden_by_consistency
    CHECK (
        (is_hidden = false AND hidden_by IS NULL AND hidden_at IS NULL)
        OR (is_hidden = true AND hidden_by IS NOT NULL AND hidden_at IS NOT NULL)
    );

-- ── Rollback ──────────────────────────────────────────────────────────────────
-- ALTER TABLE public.media DROP CONSTRAINT IF EXISTS check_hidden_by_consistency;
-- DROP INDEX  IF EXISTS public.idx_media_hidden_at;
-- DROP INDEX  IF EXISTS public.idx_media_is_hidden;
-- ALTER TABLE public.media DROP COLUMN IF EXISTS hidden_by;
-- ALTER TABLE public.media DROP COLUMN IF EXISTS hidden_at;
-- ALTER TABLE public.media DROP COLUMN IF EXISTS is_hidden;
