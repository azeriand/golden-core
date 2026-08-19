-- Migration: Add media_type column to public.media
-- Purpose: Distinguish between image and video uploads
-- Requirement: 2.2

ALTER TABLE public.media
  ADD COLUMN media_type VARCHAR(10) NOT NULL DEFAULT 'image';

ALTER TABLE public.media
  ADD CONSTRAINT media_type_check CHECK (media_type IN ('image', 'video'));
