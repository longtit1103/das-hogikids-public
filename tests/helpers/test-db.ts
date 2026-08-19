import { prisma } from "@/lib/prisma";

/**
 * Helper DB test dùng chung cho các suite integration (`hogikids_test`).
 *
 * KHÔNG `prisma db push` ở đây: schema test đã được đẩy sẵn (các suite
 * integration hiện hành — vd tests/ingest, tests/queries — đều dựa vào điều
 * này và chạy pass). Push lại mỗi lần vừa thừa vừa chậm.
 *
 * Cung cấp:
 *  - seedReference(): upsert 4 kênh + 7 danh mục chi phí hệ thống (dữ liệu
 *    tham chiếu, tồn tại suốt vòng đời suite; gọi 1 lần trong beforeAll).
 *  - truncateBusinessTables(): xoá các bảng nghiệp vụ theo thứ tự an toàn FK
 *    (gọi trong beforeEach để mỗi test khởi đầu sạch); GIỮ lại Channel +
 *    ExpenseCategory để không phải seed lại tham chiếu giữa các test.
 *
 * Phase 5/6 tái dùng nguyên helper này — đừng đổi chữ ký export.
 */

// Khớp prisma/seed.ts để test chạy trên đúng dữ liệu tham chiếu như prod.
const CHANNELS = [
  { id: "shopee", name: "Shopee", color: "#cc785c", platformFeePct: 10, paymentFeePct: 2.5, sortOrder: 1 },
  { id: "tiktok", name: "TikTok Shop", color: "#141413", platformFeePct: 6, paymentFeePct: 2, sortOrder: 2 },
  { id: "facebook", name: "Facebook/Instagram", color: "#5db8a6", platformFeePct: 0, paymentFeePct: 0, sortOrder: 3 },
  { id: "website", name: "Website/Khác", color: "#e8a55a", platformFeePct: 0, paymentFeePct: 0, sortOrder: 4 },
];

const EXPENSE_CATEGORIES = [
  { id: "purchase", name: "Nhập hàng" },
  { id: "ads", name: "Quảng cáo" },
  { id: "shipping", name: "Vận chuyển" },
  { id: "packaging", name: "Đóng gói" },
  { id: "return_bom", name: "Hoàn/Bom hàng" },
  { id: "fixed", name: "Mặt bằng-cố định" },
  { id: "other", name: "Khác" },
];

/** Upsert dữ liệu tham chiếu (kênh + danh mục hệ thống). Idempotent. */
export async function seedReference(): Promise<void> {
  for (const c of CHANNELS) {
    await prisma.channel.upsert({ where: { id: c.id }, create: c, update: {} });
  }
  for (const cat of EXPENSE_CATEGORIES) {
    await prisma.expenseCategory.upsert({
      where: { id: cat.id },
      create: { id: cat.id, name: cat.name, isSystem: true },
      update: { isSystem: true },
    });
  }
}

/**
 * Xoá dữ liệu nghiệp vụ theo thứ tự an toàn khoá ngoại (con → cha):
 * OrderItem → Order → Expense → RecurringExpense → Variant → Product.
 * Không đụng Channel/ExpenseCategory (dữ liệu tham chiếu).
 */
export async function truncateBusinessTables(): Promise<void> {
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.expense.deleteMany();
  await prisma.recurringExpense.deleteMany();
  await prisma.variant.deleteMany();
  await prisma.product.deleteMany();
  // Silver "tiền đã về" TikTok (Phase 2) + ví Shopee (Phase 3) — không FK, xoá độc lập.
  await prisma.tiktokSettlement.deleteMany();
  await prisma.tiktokAdsSettlement.deleteMany();
  await prisma.tiktokPayment.deleteMany();
  await prisma.shopeeSettlement.deleteMany();
}
