-- Add blurhash column to media table for image placeholders
ALTER TABLE public.media
ADD COLUMN blurhash VARCHAR(100);
