-- Migration: Add media.width and media.height (intrinsic pixel dimensions).
-- Purpose: Persist the intrinsic pixel dimensions of the uploaded media so the
--          gallery's segmented justified layout can compute row heights BEFORE
--          the image loads (no layout shift). Dimensions are produced client-side
--          during image preprocessing (lib/image-preprocess.ts already computes
--          width/height) and threaded through the confirm pipeline exactly like
--          the existing blurhash field.
-- Notes: Additive and reversible, mirroring migration 004. Both columns are
--        nullable integers with no default, so ALL existing media rows stay
--        valid (width/height NULL, interpreted by the client as "unknown —
--        measure on load"). No existing column, constraint, index, or data on
--        public.media is modified. Runs as a single unit; a failure applies
--        nothing partial.
--        As recorded in migration 004, schema.sql is a stale pg_dump; the LIVE
--        media table (with blurhash/type/upload_id/poster_url) is driven by the
--        migrations, so this targets the deployed table.

-- Additive nullable columns on media. NULL = dimensions unknown for that row
-- (legacy rows, or uploads whose preprocessing could not measure the image, e.g.
-- videos and skipped/failed images); the client falls back to on-load measurement.
ALTER TABLE public.media
  ADD COLUMN width  integer,
  ADD COLUMN height integer;

-- Rollback (reverse order). Restores the schema to its pre-migration state.
-- Additive/reversible — no existing media column, constraint, index, or data is
-- touched:
-- ALTER TABLE public.media DROP COLUMN IF EXISTS height;
-- ALTER TABLE public.media DROP COLUMN IF EXISTS width;
