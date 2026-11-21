-- ==============================================================================
-- DỮ LIỆU SEED MÔI TRƯỜNG PHÁT TRIỂN (DEVELOPMENT SEED DATA)
-- Tệp độc lập: CHỈ CHẠY TRÊN LOCAL DEV / STAGING REHEARSAL
-- TUYỆT ĐỐI KHÔNG CHẠY TỰ ĐỘNG TRÊN PRODUCTION
-- ==============================================================================

DO $$
DECLARE
    v_novel_id UUID;
    v_chap1_id UUID;
    v_chap2_id UUID;
    v_chap3_id UUID;
BEGIN
    -- 1. Thêm truyện mẫu: Khấu Vấn Tiên Đạo
    INSERT INTO novels (slug, title, author, description, cover_image_url)
    VALUES (
        'khau-van-tien-dao',
        'Khấu Vấn Tiên Đạo',
        'Vũ Đả Thanh Thạch',
        'Phàm nhân thiếu niên Tần Tang, ngẫu nhiên bước vào tu tiên giới, cầm kiếm hỏi đạo trường sinh, kinh tâm động phách, nghịch thiên cải mệnh.',
        '/images/home_image.png'
    )
    ON CONFLICT (slug) DO UPDATE SET title = EXCLUDED.title
    RETURNING id INTO v_novel_id;

    -- 2. Chương 1
    INSERT INTO chapters (novel_id, chapter_sequence, chapter_number, title, content, content_status)
    VALUES (
        v_novel_id,
        1,
        'Chương 1',
        'Khởi Đầu Gian Nan',
        E'Mưa thu rả rích, gió lạnh thấu xương.\n\nBên trong miếu đổ nát ngoại thành, thiếu niên Tần Tang cuộn mình trong manh áo rách tả tơi, bờ môi tái nhợt vì đói rét. Trước ngực hắn, một miếng ngọc bội cổ xưa tản ra luồng hơi ấm mỏng manh như có như không, giữ lại tia sinh cơ cuối cùng trong đêm đông nghiệt ngã.\n\n"Thế gian này thật sự có tiên nhân sao?" - Tần Tang lẩm bẩm trong cơn mê sảng, hai mắt hướng về phía màn đêm vô tận...',
        'Published'
    )
    ON CONFLICT (novel_id, chapter_sequence) DO UPDATE SET content = EXCLUDED.content
    RETURNING id INTO v_chap1_id;

    -- Phiên bản nội dung Chương 1
    INSERT INTO chapter_versions (chapter_id, version, content_hash, content, is_active)
    VALUES (
        v_chap1_id,
        1,
        encode(digest(E'Khởi Đầu Gian Nan...', 'sha256'), 'hex'),
        E'Mưa thu rả rích, gió lạnh thấu xương...',
        TRUE
    )
    ON CONFLICT (chapter_id, version) DO NOTHING;

    -- Trạng thái AI phiên bản active Chương 1
    INSERT INTO chapter_ai_status (chapter_id, version, ai_status, is_ai_active)
    VALUES (v_chap1_id, 1, 'Completed', TRUE)
    ON CONFLICT (chapter_id, version) DO NOTHING;

    -- 3. Chương 2
    INSERT INTO chapters (novel_id, chapter_sequence, chapter_number, title, content, content_status)
    VALUES (
        v_novel_id,
        2,
        'Chương 2',
        'Huyền Môn Bí Ký',
        E'Trời vừa hửng sáng, một lão đạo sĩ áo xanh bước vào miếu hoang tránh mưa.\n\nLão đạo nhìn thấy miếng ngọc trước ngực Tần Tang, ánh mắt chợt lóe lên tia kinh ngạc: "Cốt cách thanh kỳ, lại mang di vật của tông môn ta... Đứa trẻ này cùng lão đạo có phần duyên phận."\n\nTừ trong tay áo, lão đạo lấy ra một cuốn da thú ố vàng đặt bên cạnh Tần Tang, thản nhiên cất lời: "Đây là Khấu Vấn Kinh, nếu ngươi có thể tự mình đả thông kinh mạch trong vòng ba tháng, lão đạo sẽ dẫn ngươi nhập môn."',
        'Published'
    )
    ON CONFLICT (novel_id, chapter_sequence) DO UPDATE SET content = EXCLUDED.content
    RETURNING id INTO v_chap2_id;

    -- Phiên bản nội dung Chương 2
    INSERT INTO chapter_versions (chapter_id, version, content_hash, content, is_active)
    VALUES (
        v_chap2_id,
        1,
        encode(digest(E'Huyền Môn Bí Ký...', 'sha256'), 'hex'),
        E'Trời vừa hửng sáng, một lão đạo sĩ áo xanh bước vào miếu hoang...',
        TRUE
    )
    ON CONFLICT (chapter_id, version) DO NOTHING;

    -- Trạng thái AI phiên bản active Chương 2
    INSERT INTO chapter_ai_status (chapter_id, version, ai_status, is_ai_active)
    VALUES (v_chap2_id, 1, 'Completed', TRUE)
    ON CONFLICT (chapter_id, version) DO NOTHING;

    -- 4. Chương 3
    INSERT INTO chapters (novel_id, chapter_sequence, chapter_number, title, content, content_status)
    VALUES (
        v_novel_id,
        3,
        'Chương 3',
        'Ngưng Khí Tầng Đầu',
        E'Trải qua ba mươi ngày đêm khổ tu không ngừng nghỉ theo khẩu quyết trong Cổ Thư, rốt cuộc vào một đêm trăng tròn, Tần Tang cảm nhận được một luồng nhiệt lưu tí hon tựa như sợi tóc lưu chuyển trong đan điền.\n\n"Khí cảm! Đây chính là linh lực trong truyền thuyết!"\n\nHắn mở bừng mắt, trong con ngươi tựa hồ có linh quang ẩn hiện. Con đường tu tiên đầy gian nan hiểm ác, từ giây phút này chính thức mở ra trước mắt thiếu niên.',
        'Published'
    )
    ON CONFLICT (novel_id, chapter_sequence) DO UPDATE SET content = EXCLUDED.content
    RETURNING id INTO v_chap3_id;

    -- Phiên bản nội dung Chương 3
    INSERT INTO chapter_versions (chapter_id, version, content_hash, content, is_active)
    VALUES (
        v_chap3_id,
        1,
        encode(digest(E'Ngưng Khí Tầng Đầu...', 'sha256'), 'hex'),
        E'Trải qua ba mươi ngày đêm khổ tu không ngừng nghỉ...',
        TRUE
    )
    ON CONFLICT (chapter_id, version) DO NOTHING;

    -- Trạng thái AI phiên bản active Chương 3
    INSERT INTO chapter_ai_status (chapter_id, version, ai_status, is_ai_active)
    VALUES (v_chap3_id, 1, 'Pending', TRUE)
    ON CONFLICT (chapter_id, version) DO NOTHING;

    RAISE NOTICE 'Dev seed hoàn tất: 1 tiểu thuyết, 3 chương và phiên bản AI active.';
END $$;
