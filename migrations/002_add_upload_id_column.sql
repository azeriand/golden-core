-- Migration: Add upload_id correlation column to public.media
-- Purpose: Enable idempotent, duplicate-free media creation. A client-generated
--          UUID v4 (upload_id) flows from the token handshake through the Blob
--          pathname and confirm body into this column. A partial UNIQUE index
--          enforces at most one media row per non-null upload_id, making
--          ON CONFLICT (upload_id) DO NOTHING the atomic dedupe primitive.
-- Requirement: 16.4, 13.3, 7.5
-- Notes: Additive and reversible. The column is nullable with no default, so all
--        existing rows remain valid (upload_id stays NULL). No existing column,
--        constraint, index, or data is modified. Verified against the LIVE
--        public.media schema (schema.sql is stale per audit Finding 1.9).

ALTER TABLE public.media
  ADD COLUMN upload_id UUID;

CREATE UNIQUE INDEX media_upload_id_key
  ON public.media (upload_id)
  WHERE upload_id IS NOT NULL;

-- Rollback (reverse order: drop the index first, then the column):
-- DROP INDEX IF EXISTS public.media_upload_id_key;
-- ALTER TABLE public.media DROP COLUMN IF EXISTS upload_id;
