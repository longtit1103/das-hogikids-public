# das-hogikids

Ứng dụng nội bộ **theo dõi sức khoẻ kinh doanh** cho một shop bán lẻ online: đồng bộ dữ liệu vận hành từ **Pancake POS** (+ TikTok Shop, Meta/TikTok Ads) về app, bổ sung giá vốn và chi phí, rồi tính lãi/lỗ (P&L) theo kênh. App **không** làm thay vận hành — đơn/sản phẩm/tồn kho trong app là view read-only; nguồn vận hành vẫn ở Pancake.

> Đây là **bản chụp mã nguồn công khai** (public snapshot) của một app nội bộ. Đã lược bỏ tài liệu vận hành, kế hoạch nội bộ và mọi thông tin hạ tầng/kinh doanh riêng. Cấu hình thật nằm ở `.env` (không commit) — xem `.env.example` cho danh sách biến.

## Tech stack

Next.js 16 (App Router, Turbopack) + TypeScript · Prisma + PostgreSQL 15 · Tailwind 4 + shadcn/ui · Recharts · zod · iron-session · Vitest + Playwright · n8n (đồng bộ dữ liệu theo lịch/webhook).

## Kiến trúc dữ liệu (tóm tắt)

```
Nguồn (Pancake / TikTok Shop / Ads)
   → n8n fetch (text thô)
   → Bronze (raw, bất biến)
   → Silver (chuẩn hoá, idempotent theo pancakeId/refId)
   → P&L / báo cáo (nguồn chuẩn: src/lib/reports/pnl.ts)
```

Giá vốn (`Variant.costPrice`) và một số ngưỡng là **app-owned**: ingest chỉ prefill khi tạo mới, không ghi đè khi cập nhật (giữ giá sửa tay).

## Chạy dev

```bash
cp .env.example .env        # điền giá trị thật — xem chú thích trong file
npm install
npm run dev                 # http://localhost:3000

npm test                    # Vitest (cần TEST_DATABASE_URL trỏ DB test riêng)
npm run test:e2e            # Playwright
npm run build
```

> ⚠️ Test ghi/reset dữ liệu — **luôn** trỏ `TEST_DATABASE_URL` sang một database test riêng, tách khỏi mọi DB thật.

## Cấu trúc thư mục

| Thư mục | Nội dung |
|---|---|
| `src/` | Mã nguồn app (Next.js App Router, lib nghiệp vụ, API routes) |
| `prisma/` | Schema + migrations |
| `tests/` | Vitest (unit/integration) + Playwright (e2e) + fixtures |
| `scripts/` | Tiện ích vận hành/đối soát (chạy bằng `tsx`) |
| `third-party/` | Vendor tarball (xlsx — Apache-2.0, kèm README nguồn) |

## Giấy phép

Chưa cấp phép mở — **all rights reserved**. Mã nguồn công khai để tham khảo; không có quyền tái sử dụng, sửa đổi hay phân phối lại nếu không có thoả thuận riêng.
