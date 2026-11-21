-- ==============================================================================
-- MIGRATION 002: Bổ sung trạng thái tài khoản người dùng (Account Status)
-- Dự án: Khấu Vấn Tiên Đạo (Read-Novel) - Phase 1.5 Architecture (Step 3)
-- ==============================================================================

-- 1. Bổ sung cột is_active và disabled_at vào bảng users một cách an toàn
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'users' 
          AND column_name = 'is_active'
    ) THEN
        ALTER TABLE users ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'users' 
          AND column_name = 'disabled_at'
    ) THEN
        ALTER TABLE users ADD COLUMN disabled_at TIMESTAMP WITH TIME ZONE NULL;
    END IF;
END $$;

-- 2. Đánh chỉ mục (Index) trên is_active để tăng tốc xác thực người dùng
CREATE INDEX IF NOT EXISTS idx_users_is_active ON users(is_active);

-- 3. Ghi chú tài liệu hóa schema
COMMENT ON COLUMN users.is_active IS 'Trạng thái hoạt động tài khoản: TRUE = hoạt động, FALSE = bị khóa/vô hiệu hóa';
COMMENT ON COLUMN users.disabled_at IS 'Thời điểm tài khoản bị vô hiệu hóa (NULL nếu đang hoạt động)';
