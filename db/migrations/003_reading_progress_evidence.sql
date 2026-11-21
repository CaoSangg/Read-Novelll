-- 4.7.1a / Option C. Run once, after 001 and 002, on a verified target.
-- One DO statement makes all DDL atomic, including with an autocommit caller.
-- The runner should also use a transaction, lock_timeout and statement_timeout.
-- No data backfill, content digest computation, CAS writer or AI authorization here.
DO $migration$
BEGIN
    IF to_regclass('public.reading_chapter_completions') IS NOT NULL THEN
        RAISE EXCEPTION 'Migration 003: completion ledger already exists; inspect schema before retry';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'is_active'
    ) OR NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'disabled_at'
    ) THEN
        RAISE EXCEPTION 'Migration 003 requires migration 002';
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.reading_progress
        WHERE scroll_position IS NOT NULL AND NOT (scroll_position BETWEEN 0.0 AND 1.0)
    ) THEN
        RAISE EXCEPTION 'Migration 003: invalid legacy scroll; audit required, no automatic repair';
    END IF;

    ALTER TABLE public.reading_progress
        ADD COLUMN revision BIGINT NOT NULL DEFAULT 0,
        ADD COLUMN resume_writer_epoch UUID,
        ADD COLUMN resume_content_hash BYTEA,
        ADD COLUMN resume_hash_scheme TEXT,
        ALTER COLUMN max_read_sequence SET DEFAULT 0,
        ADD CONSTRAINT ck_progress_revision_nonnegative CHECK (revision >= 0),
        ADD CONSTRAINT ck_progress_resume_hash CHECK (
            (resume_content_hash IS NULL AND resume_hash_scheme IS NULL)
            OR (
                resume_content_hash IS NOT NULL AND resume_hash_scheme IS NOT NULL
                AND octet_length(resume_content_hash) = 32
                AND resume_hash_scheme = 'sha256-utf8-raw-v1'
            )
        ),
        ADD CONSTRAINT ck_progress_scroll_range CHECK (
            scroll_position IS NULL OR scroll_position BETWEEN 0.0 AND 1.0
        );

    -- PostgreSQL needs a matching unique key for the composite FK below.
    -- Neither chapters(id) nor chapters(novel_id, chapter_sequence) can back it.
    ALTER TABLE public.chapters
        ADD CONSTRAINT uq_chapters_novel_id_id UNIQUE (novel_id, id);

    CREATE TABLE public.reading_chapter_completions (
        user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
        novel_id UUID NOT NULL,
        chapter_id UUID NOT NULL,
        content_hash BYTEA NOT NULL,
        hash_scheme TEXT NOT NULL DEFAULT 'sha256-utf8-raw-v1',
        completion_policy_version SMALLINT NOT NULL DEFAULT 1,
        completion_source TEXT NOT NULL DEFAULT 'explicit',
        completed_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
        CONSTRAINT reading_chapter_completions_pkey PRIMARY KEY (user_id, chapter_id),
        CONSTRAINT fk_completions_novel_chapter FOREIGN KEY (novel_id, chapter_id)
            REFERENCES public.chapters(novel_id, id) ON DELETE CASCADE,
        CONSTRAINT ck_completions_hash_length CHECK (octet_length(content_hash) = 32),
        CONSTRAINT ck_completions_hash_scheme CHECK (hash_scheme = 'sha256-utf8-raw-v1'),
        CONSTRAINT ck_completions_policy CHECK (completion_policy_version = 1),
        CONSTRAINT ck_completions_source CHECK (completion_source = 'explicit')
    );

    -- PK supports ownership/uniqueness and user deletion. These have distinct uses:
    -- per-user/novel evidence lookup; child lookup for chapter/novel cascades.
    CREATE INDEX idx_completions_user_novel
        ON public.reading_chapter_completions (user_id, novel_id);
    CREATE INDEX idx_completions_novel_chapter
        ON public.reading_chapter_completions (novel_id, chapter_id);

    COMMENT ON COLUMN public.reading_progress.max_read_sequence IS
        'Frozen legacy advisory value. New progress flows must never update it or derive completion/AI from it.';
    COMMENT ON COLUMN public.reading_progress.revision IS
        'CAS counter managed atomically by future service; no automatic increment trigger.';
    COMMENT ON COLUMN public.reading_progress.resume_writer_epoch IS
        'Writer generation for future Resume activate/update; NULL means unclaimed legacy row.';
    COMMENT ON COLUMN public.reading_progress.resume_content_hash IS
        '32-byte digest of content at Resume write; NULL legacy content revision is unknown.';
    COMMENT ON COLUMN public.reading_progress.resume_hash_scheme IS
        'sha256-utf8-raw-v1: SHA-256 of exact UTF-8 chapters.content, no BOM/normalization/newline conversion.';
    COMMENT ON TABLE public.reading_chapter_completions IS
        'One explicit completion evidence per user/chapter. Keep old evidence on content/status edits; no Resume dependency.';
END;
$migration$;
