-- Make media.section_id nullable so unclassified media no longer needs a
-- per-event "Sin clasificar" row. Media that cannot be auto-categorized is now
-- stored with section_id = NULL and surfaced under a hardcoded fallback section
-- synthesized by the API. See lib/sections.ts.
--
-- The existing composite FK (section_id, event_id) -> sections uses the default
-- MATCH SIMPLE semantics, so a row with a NULL section_id is not checked
-- against the FK. Dropping NOT NULL is therefore sufficient.

ALTER TABLE public.media
    ALTER COLUMN section_id DROP NOT NULL;

-- Detach any media currently parked in a manually-created "Sin clasificar"
-- section, then remove those rows so classification is no longer influenced by
-- their full-range dates. Real sections are left untouched.
UPDATE public.media m
SET section_id = NULL
FROM public.sections s
WHERE m.section_id = s.section_id
  AND m.event_id = s.event_id
  AND s.section_name = 'Sin clasificar';

DELETE FROM public.sections
WHERE section_name = 'Sin clasificar';
