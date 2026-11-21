-- A NULL removed_at keeps every existing bookmark active.
-- Retaining removed rows preserves legacy notes and the existing unique key.
ALTER TABLE public.bookmarks ADD COLUMN removed_at TIMESTAMPTZ;
