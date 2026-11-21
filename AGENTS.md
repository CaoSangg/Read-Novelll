# AGENTS.md — Quy tắc làm việc cho AI Agent (Read-Novel)

- **Dự án** S-ReadNovel
- **Nhánh phát triển** `feature/aws-migration`.
- **Mốc xác nhận ngày 21/11/2026** Developer đã nghiệm thu thủ công Bước 4. Bước tiếp theo là Docker hóa FastAPI.

## 1. Trạng thái Phase 1.5

| Bước | Trạng thái |
|---|---|
| 1 — Audit Supabase | COMPLETED |
| 2 — PostgreSQL Schema & Python Pool | COMPLETED |
| 3 — Authentication & Session | COMPLETED |
| 4 — Jinja2 UI & Reader Engine | COMPLETED — developer đã nghiệm thu thủ công |
| 5 — Docker hóa FastAPI | NEXT — NOT STARTED |
| 6 — GitHub Actions CI/CD | NOT STARTED trong phạm vi FastAPI Phase 1.5 |
| 7–10 — AWS, migration, rehearsal và cutover | Chưa nghiệm thu. Xác minh roadmap đã được developer duyệt trước khi triển khai. |

- FastAPI/Jinja2 và Vanilla JavaScript là stack migration. Code khai báo Python ≥3.11 và Ruff target `py311`. Môi trường local đã kiểm tra dùng Python 3.12. PostgreSQL 16 dùng `pgvector`, `pg_trgm`, Psycopg 3 và `AsyncConnectionPool`.
- Bước 4 bao gồm Jinja2 UI, điều hướng Reader, TOC và Forward Jump Confirmation, Resume, Manual Completion, Offline Sync, Guest/Auth Bookmark, tích hợp đăng nhập/đăng xuất, account isolation, Guest/Auth Simplification và Final UI/UX Hotfix.
- Bản cũ hiện hành dùng Next.js 14, React, TypeScript, Tailwind CSS, Supabase và Vercel. Giữ production và mã legacy cho tới cutover được developer phê duyệt.
- Compose PostgreSQL dành cho test và GitHub workflows cũ đã tồn tại. Trạng thái Bước 5–6 chỉ tính theo phạm vi FastAPI được giao và nghiệm thu.

### Baseline lịch sử khi kết thúc Bước 4

| Nguồn | Kết quả |
|---|---|
| Developer | Tự kiểm tra và xác nhận UI/UX và Reader Engine cuối Bước 4 đạt yêu cầu. |
| Agent, Final UI/UX Hotfix | 422 Python PASS, 111 JavaScript PASS, Ruff lint/format và Node syntax PASS. |
| Agent, Edge Browser QA | Matrix đầu 10/12 PASS. Cả 12 tổ hợp Auto/Fresh có lượt PASS cuối sau các lượt chạy riêng. Tổng lịch sử regression 14 PASS, 4 FAIL. |

Baseline thuộc lần kiểm thử Bước 4. Ghi riêng kết quả chạy trên thay đổi hoặc checkpoint mới khi có kiểm thử thực tế.

## 2. Thứ tự ưu tiên và nguồn xác minh

1. Yêu cầu mới nhất và quyết định được developer phê duyệt xác định phạm vi, chính sách và mốc nghiệm thu.
2. Schema, route, controller và test trong đúng repository xác định hành vi hiện tại. Nếu code lệch chính sách, ghi rõ điểm lệch trước khi sửa.
3. Checklist và kế hoạch cục bộ dùng để tham chiếu khi còn phù hợp. Thiết kế lịch sử về `/api/progress/sync`, tăng `max_read_sequence` hoặc Guest→Auth Import đã được thay thế.
4. Báo cáo QA của Agent ghi kết quả tại thời điểm chạy. Phân biệt báo cáo Agent, nghiệm thu thủ công của developer, hành vi đã xác minh trong code và điều chưa kiểm chứng.

Nếu tài liệu bắt buộc thiếu trong clone, báo rõ tài liệu thiếu và xác minh với developer trước khi dựa vào phần chính sách còn thiếu. Các quy tắc MVP và an toàn chính nằm ngay trong file này.

## 3. Bảo vệ Git, workspace và production

- Xác minh đúng repository và nhánh `feature/aws-migration` trước khi sửa. Bảo vệ các thay đổi staged, modified, untracked và tài sản bị ignore. Chỉ sửa trong phạm vi được giao.
- Developer tự kiểm tra, commit và push checkpoint Bước 4 lên nhánh này. Agent không tự commit, push hoặc tạo PR. Giữ `main` ngoài phạm vi merge trước quyết định cutover.
- Không chạy `git reset`, `git clean`, force-push, xóa volume Docker, drop/truncate database hoặc thao tác phá hủy dữ liệu. Không xóa hoặc viết đè mã Next.js/Supabase, dữ liệu legacy hoặc file `.env`.
- `/src/`, `/supabase/` và tài liệu cục bộ trong `/docs/` nằm ngoài checkpoint này theo quyết định của developer. Giữ nguyên nội dung trên máy và quy tắc `.gitignore`. File đã được Git theo dõi vẫn cần được bảo toàn. Không tự untrack hoặc xóa dữ liệu chỉ vì có quy tắc ignore.
- Giữ nguyên production Vercel/Supabase, DNS, AWS, deployment workflows, Dockerfile và Compose khi chúng nằm ngoài nhiệm vụ. Thay đổi cloud hoặc cutover cần quyết định riêng của developer.
- Tái sử dụng stack hiện có. Không tự đưa ORM, Redis, Celery, microservices hoặc JavaScript framework vào FastAPI.

```powershell
pwd
git rev-parse --show-toplevel
git branch --show-current
git status --short
git diff --stat
```

## 4. Quy chuẩn Python, PostgreSQL và Authentication

### Backend và migrations

- Dùng FastAPI, Pydantic v2, router/service/schema/dependency theo code hiện có. Đặt nghiệp vụ trong service. Tái sử dụng singleton `psycopg_pool.AsyncConnectionPool` do FastAPI lifespan quản lý, dùng context manager cho connection/transaction và truyền tham số SQL riêng.
- Dùng schema thực tế. `chapter_sequence` phục vụ sắp xếp/điều hướng, `chapter_number` phục vụ hiển thị. Xác minh Published, liên kết novel/chapter, owner và precondition trên server.
- Trên Windows, tái sử dụng `scripts/run_local.py` với SelectorEventLoop cho Psycopg async.

| Migration | Vai trò |
|---|---|
| `db/migrations/001_init_schema_v3_2.sql` | Schema gốc và PostgreSQL extensions. |
| `db/migrations/002_add_user_status.sql` | `users.is_active` và `users.disabled_at`. |
| `db/migrations/003_reading_progress_evidence.sql` | Resume revision, writer epoch, content hash và bảng `reading_chapter_completions`. |
| `db/migrations/004_bookmark_removal.sql` | `bookmarks.removed_at` cho Soft Delete. `NULL` nghĩa là bookmark còn hoạt động. |

Giữ nguyên migrations lịch sử đã áp dụng. Thay đổi schema có chủ đích cần migration mới, audit dữ liệu và cách kiểm thử an toàn.

### Authentication và Authorization

- Giữ `pwdlib[argon2]` với Argon2id. Session là token opaque ngẫu nhiên, chỉ lưu SHA-256 token hash trong `user_sessions.refresh_token_hash`. Thu hồi bằng DELETE bản ghi session. Schema hiện tại dùng cách này thay cho cột `revoked_at`.
- Cookie session dùng HttpOnly và SameSite=Lax, bật Secure trên production. Cookie CSRF riêng cho phép frontend đọc để gửi header. Server kiểm tra Origin, CSRF, hạn session và trạng thái kích hoạt tài khoản.
- Đăng ký cấp role Reader. Quyền Admin do backend xác minh từ PostgreSQL. Dùng `/api/auth/*` cho register, login, logout, change-password, me và csrf-token. Giữ auth của FastAPI theo opaque session đã duyệt, không đưa JWT, bcrypt/passlib, NextAuth, OAuth migration hoặc Next.js API routes vào stack mới.
- Chỉ tin forwarded headers từ proxy đã cấu hình. Rate limiter in-memory hiện phù hợp cấu hình một Uvicorn worker. Giữ các kiểm tra bảo mật khi thay runtime hoặc worker.
- Không ghi session token thô vào DB hoặc LocalStorage. Session token chỉ đi qua cookie HttpOnly. Giữ password hash và secrets ngoài HTML/API responses. Không log mật khẩu, hash, token CSRF, cookie, API key, private key hoặc nguyên `DATABASE_URL`. Khi cần dẫn chuỗi kết nối, che password.

## 5. Reader Engine — Approved MVP Policies

### Resume và Navigation

- Resume là vị trí Đọc tiếp gồm chapter Published và fraction nội dung. Vị trí có thể tiến hoặc lùi, độc lập với Completion và Bookmark. Guest Đọc tiếp dùng Resume lưu gần nhất trong scope truyện.
- Auth Resume dùng CAS, revision/ETag và writer epoch. Activate dùng `If-None-Match: *` để tạo mới hoặc `If-Match` cho row hiện có. Giữ xác minh owner, dirty-check, debounce, retry có giới hạn và đối chiếu server trước khi retry. Sau 409/412 giữ xung đột để xử lý, không tự rebase hoặc áp lại ý định cũ.
- Đóng băng `max_read_sequence` legacy. Resume và Completion dùng hợp đồng riêng. Giá trị legacy không đại diện cho một tập chương đã đọc.
- TOC xác nhận mọi cú nhảy tới chương xa hơn chương Published kế tiếp. Chọn chương trước hoặc chuyển tới chương Published kế tiếp là điều hướng trực tiếp. Completion và legacy max không quyết định bỏ qua dialog.

### Completion

- Ledger chỉ ghi bằng hành động chủ động **Đã đọc xong** hoặc **Đồng bộ xác nhận** đối với claim offline đã được tạo chủ động. Mở chương, scroll, Next, TOC và Bookmark không sinh evidence.
- Canonical revision là SHA-256 trên UTF-8 của đúng `chapters.content` theo scheme `sha256-utf8-raw-v1`. Không chuẩn hóa Unicode, newline hoặc HTML trước khi hash. Giữ evidence revision cũ khi nội dung đổi và yêu cầu xác nhận lại revision hiện tại.
- Offline Completion lưu pending theo owner và chỉ ghi server sau explicit sync với phiên hợp lệ. Giữ trạng thái pending, lỗi mạng và server-confirmed phân biệt rõ trên UI.
- AI/RAG là phạm vi tương lai. Khi được giao, áp dụng ranh giới Published prefix hoàn thành liên tục với revision hợp lệ và kiểm chứng server. Bookmark, Resume và legacy max không làm authority cho AI.

### Bookmark

- Một truyện có thể có nhiều bookmark theo chương. Guest lưu LocalStorage, Auth lưu PostgreSQL. Bookmark không thay đổi Resume hoặc Completion.
- Auth GET/PUT/DELETE giữ theo API hiện tại. Soft Delete cập nhật `removed_at`. Khôi phục đặt lại `removed_at` về `NULL` và giữ legacy note, `created_at` cùng thứ tự danh sách. Các hàng đã lưu trước simplification vẫn thuộc tài khoản tương ứng.

### Guest/Auth isolation

- Guest Resume, Completion và Bookmark nằm trong LocalStorage riêng theo truyện. Auth dùng PostgreSQL theo owner đã xác minh. Draft Auth offline lưu tạm theo owner và truyện, tách khỏi Guest và dữ liệu đã xác nhận.
- Guest/Auth Simplification thay phần import trong D6/D9. Developer đã hủy phạm vi 4.7.3c. Resume Consent và Bookmark Import đã được gỡ. Giữ luồng login tách dữ liệu và không tự khôi phục import ở nhiệm vụ sau.
- Quay lại Reader sau login chỉ đọc dữ liệu Auth đã xác minh. Tài khoản trống có thể tạo Resume bằng **Lưu vị trí tại đây** ở chương và fraction thực tế. Mở chương theo điều hướng Auth thông thường vẫn dùng Activate hiện có.
- Xác minh owner/session trước khi đọc hoặc ghi dữ liệu Auth. Reload, Back/BFCache và đổi tài khoản phải retire scope cũ khi cần, xác minh lại và chặn callback hoặc mutation cũ sang tài khoản mới.
- Logout chờ backend ACK và trả về dữ liệu Guest sẵn có trên thiết bị. Giữ LocalStorage qua login/logout, không tự thêm TTL/LRU hoặc xóa ngầm.

## 6. UI/UX baseline đã nghiệm thu

- Giữ bố cục tiên hiệp và giao diện đã nghiệm thu. Trang chủ giữ stage 16:9, Canvas particles, hình và modal. Reader giữ theme Sepia/Light/Dark, typography, độ rộng, TOC, phím tắt và điều hướng.
- Toolbar dùng brand cố định **S-ReadNovel**. Trong bài, giữ thứ tự novel title, chapter number, chapter title từ dữ liệu động. Tài khoản là menu riêng trong toolbar. Guest có Đăng nhập/Đăng ký. Auth có Đăng xuất trong menu Tài khoản.
- Dùng gear Lucide Settings. Đặt **Xóa tiến độ trên thiết bị** trong **Cài đặt đọc → Quản lý tiến độ** và giữ dialog xác nhận. Chỉ xóa Guest Resume và Completion của truyện hiện tại. Giữ Bookmark và dữ liệu tài khoản.
- Bookmark list giữ đúng tên chương sau reopen, reload và Back/BFCache. Metadata thiếu tên thì dùng trạng thái rõ và không tạo anchor rỗng. Render dữ liệu động bằng Jinja2 escaping hoặc DOM/`textContent`. Footer Completion dùng nhãn **Trạng thái:**.
- Kiểm tra responsive desktop/mobile, focus, Escape, bàn phím, hover, loading/empty/error và touch target tối thiểu 44×44px. Văn bản thường hướng tới WCAG AA 4.5:1. Tái sử dụng tokens trong `app/static/css/reader.css` và cấu hình typography hiện tại. Tránh giao diện mới ngoài yêu cầu.
- Dùng HTML/CSS, Vanilla JS và CSS biên dịch trước nếu dùng Tailwind. Không thêm React runtime hoặc Tailwind CDN vào FastAPI. Khi cần đối chiếu, dùng `src/` và HTML/CSS gốc nếu có cục bộ. Các skill như impeccable và ui-ux-pro-max chỉ dùng khi khả dụng và theo hướng dẫn thực tế, dưới baseline đã nghiệm thu.

## 7. Quy trình, kiểm thử và báo cáo

1. Xác định phạm vi, đọc code và tài liệu phù hợp. Kiểm tra git status và các dependency trước khi sửa.
2. Ưu tiên thay đổi nhỏ, dùng lại code có sẵn. Bảo toàn test cũ và cập nhật assertions khi hành vi được developer thay đổi.
3. Với thay đổi cần integration, dùng PostgreSQL local disposable có ownership marker và đúng migrations. `readnovel_test` chỉ dùng audit read-only khi chạy verifier. `readnovel_ui_test` dành cho UI developer. Không chạy fixture ghi/xóa, reset, drop hoặc truncate trên hai DB này hay production.
4. Khi làm UI, kiểm Edge tối thiểu 1920×1080 và 390×844 nếu có điều kiện. Nếu sửa toolbar, kiểm thêm 1366px, 768px và 320px. Ghi riêng BFCache thật, fresh document, lỗi assertion, lỗi ứng dụng và lỗi browser/runner/cleanup.
5. Báo kết quả thực tế PASS/FAIL/SKIP, phạm vi đã xác minh và phần chưa kiểm chứng. Kiểm thử Python, JS, hình ảnh và production security là các loại bằng chứng riêng. Giới hạn task tại bước được giao.

Khi nhiệm vụ yêu cầu regression thực tế, dùng các lệnh PowerShell sau với môi trường đã được guard. `$qaDatabase` là tên database migrated do verifier tạo.

```powershell
.\.venv\Scripts\python.exe -X utf8 scripts/check_progress_migration.py --verify
$jsTests = rg --files tests -g '*.test.cjs'
node --test $jsTests
.\.venv\Scripts\python.exe -m ruff check .
.\.venv\Scripts\python.exe -m ruff format --check .
.\.venv\Scripts\python.exe -X utf8 -m scripts.check_reader_resume_browser --database $qaDatabase --suite guest --history-mode auto
```

## 8. Next Milestone — Step 5: Dockerize FastAPI

- Khi developer giao Bước 5, audit Docker/Compose có sẵn rồi xây multi-stage Dockerfile cho FastAPI, runtime non-root, healthcheck, Local Docker Compose và xác minh build/run ARM64. Giữ Node.js ngoài production runtime nếu ứng dụng không cần. Runtime ban đầu: 1 FastAPI container, 1 Uvicorn worker. Không tự tăng workers hoặc replicas khi rate limiter còn in-memory. Việc mở rộng cần đánh giá lại rate limiting, connection pool và session behavior.
- Tái sử dụng endpoint đã có. `GET /api/health` kiểm liveness của tiến trình và không query DB. `GET /api/health/readiness` dùng connection pool chạy `SELECT 1`, trả 200 khi sẵn sàng hoặc 503 khi DB không sẵn sàng.
- Kiểm tra kết nối PostgreSQL trong Compose local, giữ an toàn migrations, volume và dữ liệu đã có. Xác minh startup, readiness và runtime bằng dữ liệu test riêng. Bước 5 chỉ đóng gói và kiểm thử local, chưa triển khai AWS.
- Checklist cũ mô tả 2 EC2 + ECR. Các phương án DevSecOps sau đó có K3s/Harbor/Terraform/Ansible. Xác minh kế hoạch mới nhất do developer phê duyệt trước Bước 6–10. Không tự chọn hạ tầng hoặc cutover từ checklist lịch sử.

### Tài liệu tham khảo cục bộ

Thư mục `docs/` có thể không có clone. Các tài liệu sau là tham chiếu bổ sung khi có trên máy.

- [Checklist Phase 1.5](docs/Checklist_10buoc_phase1.5_FASTAPI.md) và [PLAN3.1](docs/PLAN3.1.md) dùng tra lịch sử, phạm vi và acceptance criteria.
- [D1–D15 và phần thay thế Guest/Auth](docs/STEP4_7_0_POLICY_APPROVED.md), [Guest/Auth Simplification](docs/STEP4_7_GUEST_AUTH_SIMPLIFICATION_REPORT.md) và [Final UI/UX Hotfix](docs/STEP4_FINAL_UI_UX_HOTFIX_REPORT.md) ghi chính sách và bằng chứng Bước 4.
- `app/`, `db/migrations/`, `scripts/` và `tests/` là nguồn để kiểm lại hành vi trên đúng checkout.
