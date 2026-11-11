# Hướng Dẫn Cấu Hình Phase 0

> **Làm cá nhân**
> **Áp dụng cho repository:** `Read-Novelll`

---

## 1. Cấu hình GitHub Secrets cho Vercel Deploy

Để các workflow `.github/workflows/deploy-preview-feature.yaml` và `deploy-production.yaml` hoạt động:

1. Truy cập repository của bạn trên GitHub:
   `https://github.com/<your-username>/<repo-name>/settings/secrets/actions`
2. Nhấn nút **New repository secret** và thêm 3 secrets sau:
   - `VERCEL_TOKEN`: Tạo tại [Vercel Account Settings -> Tokens](https://vercel.com/account/tokens).
   - `VERCEL_ORG_ID`: Lấy trong file `.vercel/project.json` (sau khi chạy `vercel link` cục bộ) hoặc trong Vercel Team/Account Settings.
   - `VERCEL_PROJECT_ID`: Lấy trong Vercel Project Settings -> General -> Project ID.

---

## 2. Cấu hình Branch Protection trên GitHub

Để bảo đảm nhánh `main` luôn ổn định và không bị push nhầm:
1. Vào repository trên GitHub $\rightarrow$ **Settings** $\rightarrow$ chọn mục **Rulesets** (nằm ở thanh menu bên trái, dưới phần *Code, planning, and automation*).
2. Nhấn nút **New ruleset** (hoặc **New branch ruleset**).
3. **Ruleset Name:** Điền `protect-main`.
4. **Enforcement status:** Đổi từ `Disabled` sang **`Active`** (để kích hoạt luật bảo vệ).
5. **Target branches:** Nhấn **Add target** $\rightarrow$ chọn **Include default branch** (hoặc chọn *Include by pattern* rồi gõ `main`).
6. **Rules (Thiết lập các quy tắc bên dưới):**
   - [x] **Restrict deletions:** Tích chọn (để tránh lỡ tay xóa nhánh `main`).
   - [x] **Block force pushes:** Tích chọn (chặn lệnh `git push --force` làm mất lịch sử commit).
   - [x] **Require a pull request before merging:** Tích chọn:
     - **Required approvals:** Chọn **`0`** *(LƯU Ý CỰC KỲ QUAN TRỌNG: Bắt buộc chọn `0` vì bạn làm một mình, GitHub không cho phép bạn tự approve PR của chính mình; nếu để 1 approval bạn sẽ bị khóa không thể tự merge code).*
   - [x] **Require status checks to pass:** Tích chọn:
     - Nhấn **Add checks** $\rightarrow$ tìm và chọn status check: `Kiem Tra Files & Syntax` (từ workflow `pr-ci.yaml`).
     - Tích chọn **Require branches to be up to date before merging**.
7. Cuộn xuống cuối trang nhấn nút xanh **Create** để kích hoạt ruleset.

À do github actions build rồi nên cũng tắt tự build ở vercel
---

## 3. Git Workflow

Khi làm tính năng hoặc sửa lỗi mới:

```bash
# 1. Luôn xuất phát nhánh mới từ main chứ không phải nhánh khác 
# (tránh dính lịch sử commit và code của 2 nhánh khác nhau)
git checkout main
git pull origin main

# 2. Tạo nhánh tính năng mới
git checkout -b feature/ten-tinh-nang

# 3. commit
git add .
git commit -m "feat: mo ta tinh nang"

# 4. Đẩy code lên GitHub
git push origin feature/ten-tinh-nang
```

- Khi bạn push lên `feature/*`:
  - Workflow `deploy-preview-feature.yaml` sẽ tự động kích hoạt, deploy lên môi trường Preview của Vercel.
  - Link Preview URL sẽ được in trực tiếp trong tab **Actions** $\rightarrow$ mục **Summary** của đợt chạy.
- Khi tạo Pull Request vào `main`:
  - Workflow `pr-ci.yaml` tự động chạy kiểm tra chất lượng file và cú pháp HTML.
  - Sau khi CI báo xanh (Pass), bạn nhấn **Merge Pull Request**.
- Khi PR đã merge vào `main`:
  - Workflow `deploy-production.yaml` tự động chạy, kiểm tra an toàn lại một lần nữa rồi mới đẩy bản live lên Production.
 