-- ==============================================================================
-- POSTGRESQL SCHEMA v3.2 — DỰ ÁN KHẤU VẤN TIÊN ĐẠO
-- Chuẩn hóa kiến trúc 11 bảng theo Mục 3.7 PLAN 3.1 & Checklist Phase 1.5 FINAL
-- Hỗ trợ pgvector cho AI Phase (1024 chiều - Qwen3-Embedding 0.6B), 
-- HNSW Vector Index, pg_trgm Search, Session Management & OAuth Compatibility
-- ==============================================================================
-- LƯU Ý: TỆP NÀY CHỈ CHỨA DDL (KHÔNG CHỨA DỮ LIỆU SEED)
-- ==============================================================================

-- 1. KÍCH HOẠT EXTENSIONS CẦN THIẾT
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "vector";

-- 2. HÀM TỰ ĐỘNG CẬP NHẬT updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ==============================================================================
-- BẢNG 1: users (Quản lý người dùng tập trung, tương thích OAuth & Email/Password)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    username VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NULL, -- Cho phép NULL đối với tài khoản thuần OAuth
    role VARCHAR(20) DEFAULT 'Reader' CHECK (role IN ('Reader', 'Admin')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

CREATE OR REPLACE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ==============================================================================
-- BẢNG 2: user_sessions (Quản lý phiên đăng nhập & Refresh Token Rotation)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS user_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_token_hash VARCHAR(64) NOT NULL, -- SHA-256 hash của Refresh Token
    user_agent TEXT,
    ip_address VARCHAR(45),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    revoked_at TIMESTAMP WITH TIME ZONE, -- Đánh dấu vô hiệu hóa session
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_token_hash ON user_sessions(refresh_token_hash);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at ON user_sessions(expires_at);

-- ==============================================================================
-- BẢNG 3: user_identities (Quản lý liên kết danh tính đăng nhập OAuth / SSO)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS user_identities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider VARCHAR(50) NOT NULL, -- 'google', 'github', etc.
    provider_user_id VARCHAR(255) NOT NULL,
    identity_data JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_provider_user UNIQUE (provider, provider_user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_identities_user ON user_identities(user_id);

CREATE OR REPLACE TRIGGER trg_user_identities_updated_at
    BEFORE UPDATE ON user_identities
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ==============================================================================
-- BẢNG 4: novels (Danh mục thông tin tiểu thuyết)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS novels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug VARCHAR(255) UNIQUE NOT NULL,
    title VARCHAR(255) NOT NULL,
    author VARCHAR(255) NOT NULL,
    description TEXT,
    cover_image_url TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_novels_slug ON novels(slug);
CREATE INDEX IF NOT EXISTS idx_novels_title_trgm ON novels USING gin (title gin_trgm_ops);

CREATE OR REPLACE TRIGGER trg_novels_updated_at
    BEFORE UPDATE ON novels
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ==============================================================================
-- BẢNG 5: chapters (Nội dung các chương truyện xuất bản)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS chapters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    novel_id UUID NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
    chapter_sequence INT NOT NULL, -- Thứ tự tuyến tính số nguyên duy nhất (1, 2, 3...)
    chapter_number VARCHAR(50) NOT NULL, -- Hiển thị độc giả (vd: 'Chương 1', 'Ngoại truyện')
    title VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    content_status VARCHAR(20) DEFAULT 'Published' CHECK (
        content_status IN ('Draft', 'Published', 'Archived')
    ),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_novel_chapter_seq UNIQUE (novel_id, chapter_sequence)
);

CREATE INDEX IF NOT EXISTS idx_chapters_novel_seq ON chapters(novel_id, chapter_sequence);
CREATE INDEX IF NOT EXISTS idx_chapters_novel_id ON chapters(novel_id);
CREATE INDEX IF NOT EXISTS idx_chapters_title_trgm ON chapters USING gin (title gin_trgm_ops);

CREATE OR REPLACE TRIGGER trg_chapters_updated_at
    BEFORE UPDATE ON chapters
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ==============================================================================
-- BẢNG 6: chapter_versions (Quản lý phiên bản nội dung chương hiển thị cho độc giả)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS chapter_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chapter_id UUID NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    version INT NOT NULL,
    content_hash VARCHAR(64) NOT NULL,
    content TEXT NOT NULL,
    is_active BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_chapter_version_num UNIQUE (chapter_id, version)
);

-- Ràng buộc duy nhất: Mỗi chương chỉ có duy nhất 1 phiên bản nội dung active
CREATE UNIQUE INDEX IF NOT EXISTS uq_single_active_chapter_version 
ON chapter_versions (chapter_id) 
WHERE is_active = TRUE;

-- ==============================================================================
-- BẢNG 7: chapter_ai_status (SINGLE SOURCE OF TRUTH CHO PHIÊN BẢN AI ACTIVE)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS chapter_ai_status (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chapter_id UUID NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    version INT NOT NULL,
    ai_status VARCHAR(30) DEFAULT 'Pending' CHECK (
        ai_status IN ('Pending', 'Embedding Processing', 'Knowledge Processing', 'Completed', 'Failed', 'Stale')
    ),
    is_ai_active BOOLEAN DEFAULT FALSE, -- Cờ xác định phiên bản AI nào đang phục vụ RAG
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_chapter_ai_version UNIQUE (chapter_id, version)
);

-- Ràng buộc duy nhất: Mỗi chương chỉ có duy nhất 1 phiên bản AI được phép is_ai_active = TRUE
CREATE UNIQUE INDEX IF NOT EXISTS uq_single_active_ai_version
ON chapter_ai_status (chapter_id)
WHERE is_ai_active = TRUE;

CREATE OR REPLACE TRIGGER trg_chapter_ai_status_updated_at
    BEFORE UPDATE ON chapter_ai_status
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ==============================================================================
-- BẢNG 8: reading_progress (Theo dõi tiến độ đọc của tài khoản)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS reading_progress (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    novel_id UUID NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
    last_read_chapter_id UUID NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    max_read_sequence INT NOT NULL DEFAULT 1, -- Mốc chương xa nhất tài khoản từng đọc
    scroll_position FLOAT DEFAULT 0.0,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_user_novel_progress UNIQUE (user_id, novel_id)
);

CREATE INDEX IF NOT EXISTS idx_reading_progress_user ON reading_progress(user_id);
CREATE INDEX IF NOT EXISTS idx_reading_progress_user_novel ON reading_progress(user_id, novel_id);

CREATE OR REPLACE TRIGGER trg_reading_progress_updated_at
    BEFORE UPDATE ON reading_progress
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ==============================================================================
-- BẢNG 9: bookmarks (Đánh dấu chương truyện của người dùng)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS bookmarks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    novel_id UUID NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
    chapter_id UUID NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    note TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_user_chapter_bookmark UNIQUE (user_id, chapter_id)
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks(user_id);
CREATE INDEX IF NOT EXISTS idx_bookmarks_user_novel ON bookmarks(user_id, novel_id);

-- ==============================================================================
-- BẢNG 10: novel_chunks (Phân đoạn ngữ nghĩa & Vector 1024 chiều phục vụ RAG)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS novel_chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    novel_id UUID NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
    chapter_id UUID NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    version INT NOT NULL, -- Gắn với phiên bản chương được xử lý
    chapter_sequence INT NOT NULL,
    chunk_index INT NOT NULL,
    content TEXT NOT NULL,
    start_offset INT NOT NULL,
    end_offset INT NOT NULL,
    token_count INT NOT NULL,
    embedding vector(1024), -- Kiểu dữ liệu pgvector 1024 chiều (chuẩn hóa theo Qwen3-Embedding 0.6B)
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_chapter_version_chunk UNIQUE (chapter_id, version, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_chunks_spoiler_lookup ON novel_chunks (novel_id, chapter_sequence);
CREATE INDEX IF NOT EXISTS idx_chunks_version_lookup ON novel_chunks (chapter_id, version);

-- HNSW Vector Index cho tìm kiếm cosine distance phục vụ RAG
CREATE INDEX IF NOT EXISTS idx_novel_chunks_embedding_hnsw 
ON novel_chunks USING hnsw (embedding vector_cosine_ops);

-- ==============================================================================
-- BẢNG 11: ai_jobs (Hàng đợi Tác vụ AI: Lease Expiration, Idempotency & Dead-letter)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS ai_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_type VARCHAR(50) NOT NULL CHECK (
        job_type IN ('embedding', 'knowledge_extraction', 'chapter_summary')
    ),
    chapter_id UUID NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    version INT NOT NULL,
    content_hash VARCHAR(64) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending' CHECK (
        status IN ('pending', 'processing', 'completed', 'failed', 'dead_letter')
    ),
    attempt_count INT DEFAULT 0,
    max_attempts INT DEFAULT 3,
    scheduled_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    locked_at TIMESTAMP WITH TIME ZONE,
    locked_by VARCHAR(100),
    lock_expires_at TIMESTAMP WITH TIME ZONE, -- Hết hạn lease để crash recovery
    error_message TEXT,
    idempotency_key VARCHAR(128) UNIQUE NOT NULL, -- Khóa chống trùng lặp tác vụ
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ai_jobs_fetch ON ai_jobs (status, scheduled_at) 
WHERE status IN ('pending', 'failed');

CREATE INDEX IF NOT EXISTS idx_ai_jobs_lease ON ai_jobs (locked_by, lock_expires_at)
WHERE status = 'processing';

CREATE OR REPLACE TRIGGER trg_ai_jobs_updated_at
    BEFORE UPDATE ON ai_jobs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
