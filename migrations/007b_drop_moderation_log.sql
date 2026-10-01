-- Migration: Drop the moderation log table (no longer used).
-- The media visibility columns (is_hidden, hidden_at, hidden_by) added in 007
-- are kept as-is. Only the audit trail table and its indexes are removed.

DROP INDEX  IF EXISTS public.idx_moderation_log_created_at;
DROP INDEX  IF EXISTS public.idx_moderation_log_media_id;
DROP TABLE  IF EXISTS public.media_moderation_log;
