"use server";

import { getDate, endOfDay } from "date-fns";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { ActionResult } from "@/lib/actions/action-result";
import { dangPhucHoi, LOI_DANG_PHUC_HOI } from "@/lib/backup/khoa-bao-tri";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

/**
 * CRUD cho khoản chi sổ tay ("/chi-phi" modal, phase 5 tái dùng). Task 5 sẽ
 * NỐI THÊM action import ads vào cuối file này — giữ 4 action dưới đây độc
 * lập, không đổi chữ ký.
 */

const ADS_API_LOCKED_ERROR = "Dòng ads tự động từ API — xem log ở Cài đặt › Kết nối";

const baseExpenseFields = {
  date: z.coerce.date().refine((d) => d <= endOfDay(new Date()), "Không cho ngày tương lai"),
  categoryId: z.string().min(1, "Chọn danh mục"),
  adsSource: z.enum(["META", "TIKTOK_ADS", "SHOPEE_ADS"]).optional(), // nhập tay/import; ADS_API chỉ do ingest ghi
  // Trần 2 tỷ: Prisma Int (int32) chết ở 2.147.483.647 — vượt trần thì Postgres
  // out-of-range và user chỉ thấy lỗi generic. Chặn tại biên với message rõ.
  amount: z.coerce
    .number()
    .int()
    .positive("Số tiền phải lớn hơn 0")
    .max(2_000_000_000, "Số tiền quá lớn (tối đa 2 tỷ)"),
  channelId: z.string().nullable().default(null),
  description: z.string().max(200, "Tối đa 200 ký tự").default(""),
};

/** Danh mục "ads" bắt buộc chọn nguồn ads — dùng chung cho create/update. */
function requireAdsSource(d: { categoryId: string; adsSource?: string }): boolean {
  return d.categoryId !== "ads" || !!d.adsSource;
}

/** Danh mục "ads" không cho lặp hàng tháng — số ads tự về mỗi đêm qua ingest/import CSV. */
function blockRecurringAds(d: { categoryId: string; recurringMonthly: boolean }): boolean {
  return !(d.categoryId === "ads" && d.recurringMonthly);
}

const createExpenseSchema = z
  .object({ ...baseExpenseFields, recurringMonthly: z.boolean().default(false) })
  .refine(requireAdsSource, { message: "Chọn nguồn ads", path: ["adsSource"] })
  .refine(blockRecurringAds, {
    message:
      "Chi phí quảng cáo không hỗ trợ lặp hàng tháng — số ads tự về mỗi đêm hoặc nhập qua Import CSV",
    path: ["recurringMonthly"],
  });

const updateExpenseSchema = z
  .object(baseExpenseFields)
  .refine(requireAdsSource, { message: "Chọn nguồn ads", path: ["adsSource"] });

/** Lỗi zod đầu tiên → {error, field} tiếng Việt (message đã tiếng Việt sẵn trong schema). */
function mapZodError(error: z.ZodError): { error: string; field?: string } {
  const issue = error.issues[0];
  return { error: issue.message, field: issue.path.length ? String(issue.path[0]) : undefined };
}

/** Danh mục phải tồn tại + chưa bị ẩn. */
async function validateCategory(categoryId: string): Promise<string | null> {
  const category = await prisma.expenseCategory.findUnique({ where: { id: categoryId } });
  if (!category || category.isHidden) return "Danh mục không hợp lệ";
  return null;
}

/** Kênh (nếu có chọn) phải tồn tại. */
async function validateChannel(channelId: string | null): Promise<string | null> {
  if (!channelId) return null;
  const channel = await prisma.channel.findUnique({ where: { id: channelId } });
  if (!channel) return "Kênh không hợp lệ";
  return null;
}

/**
 * Tạo khoản chi. `recurringMonthly=true` → tạo `RecurringExpense` + 1
 * `Expense{source:"RECURRING"}` ngay cho ngày đã chọn (trong 1 transaction)
 * để `ensureRecurringExpenses` không sinh trùng tháng này.
 */
export async function createExpense(input: unknown): Promise<ActionResult> {
  await requireUser();
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const parsed = createExpenseSchema.safeParse(input);
  if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };
  const data = parsed.data;

  const categoryError = await validateCategory(data.categoryId);
  if (categoryError) return { ok: false, error: categoryError, field: "categoryId" };
  const channelError = await validateChannel(data.channelId);
  if (channelError) return { ok: false, error: channelError, field: "channelId" };

  try {
    if (data.recurringMonthly) {
      await prisma.$transaction(async (tx) => {
        const recurring = await tx.recurringExpense.create({
          data: {
            categoryId: data.categoryId,
            amount: data.amount,
            dayOfMonth: getDate(data.date),
            description: data.description,
            channelId: data.channelId,
            active: true,
          },
        });
        await tx.expense.create({
          data: {
            date: data.date,
            categoryId: data.categoryId,
            adsSource: data.adsSource,
            description: data.description,
            channelId: data.channelId,
            amount: data.amount,
            source: "RECURRING",
            recurringId: recurring.id,
          },
        });
      });
    } else {
      await prisma.expense.create({
        data: {
          date: data.date,
          categoryId: data.categoryId,
          adsSource: data.adsSource,
          description: data.description,
          channelId: data.channelId,
          amount: data.amount,
          source: "MANUAL",
        },
      });
    }
  } catch {
    return { ok: false, error: "Lỗi khi tạo khoản chi" };
  }

  revalidatePath("/tai-chinh");
  return { ok: true, data: undefined };
}

/**
 * Sửa khoản chi hiện có: chỉ đổi date/categoryId/adsSource/amount/channelId/
 * description — KHÔNG đụng `source`/`recurringId`/`refId`. Khoá dòng
 * `source==="ADS_API"` (ghi tự động từ ingest, không cho sửa tay).
 */
export async function updateExpense(id: string, input: unknown): Promise<ActionResult> {
  await requireUser();
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const existing = await prisma.expense.findUnique({ where: { id } });
  if (!existing) return { ok: false, error: "Không tìm thấy khoản chi" };
  if (existing.source === "ADS_API") {
    return { ok: false, error: ADS_API_LOCKED_ERROR, code: "ADS_API_LOCKED" };
  }

  const parsed = updateExpenseSchema.safeParse(input);
  if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };
  const data = parsed.data;

  const categoryError = await validateCategory(data.categoryId);
  if (categoryError) return { ok: false, error: categoryError, field: "categoryId" };
  const channelError = await validateChannel(data.channelId);
  if (channelError) return { ok: false, error: channelError, field: "channelId" };

  try {
    await prisma.expense.update({
      where: { id },
      data: {
        date: data.date,
        categoryId: data.categoryId,
        adsSource: data.adsSource ?? null, // đổi danh mục ra khỏi "ads" phải xoá adsSource cũ
        amount: data.amount,
        channelId: data.channelId,
        description: data.description,
      },
    });
  } catch {
    return { ok: false, error: "Lỗi khi cập nhật khoản chi" };
  }

  revalidatePath("/tai-chinh");
  return { ok: true, data: undefined };
}

/**
 * Xoá 1 khoản chi. `mode="stop_recurring"` (chỉ hợp lệ khi bản ghi có
 * `recurringId`) xoá dòng NÀY + tắt `RecurringExpense.active` trong 1
 * transaction — các khoản đã sinh tháng trước giữ nguyên.
 */
export async function deleteExpense(
  id: string,
  mode: "only" | "stop_recurring"
): Promise<ActionResult> {
  await requireUser();
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const existing = await prisma.expense.findUnique({ where: { id } });
  if (!existing) return { ok: false, error: "Không tìm thấy khoản chi" };
  if (existing.source === "ADS_API") {
    return { ok: false, error: ADS_API_LOCKED_ERROR, code: "ADS_API_LOCKED" };
  }
  if (mode === "stop_recurring" && !existing.recurringId) {
    return { ok: false, error: "Khoản chi này không phải khoản định kỳ" };
  }

  try {
    if (mode === "stop_recurring" && existing.recurringId) {
      await prisma.$transaction([
        prisma.expense.delete({ where: { id } }),
        prisma.recurringExpense.update({ where: { id: existing.recurringId }, data: { active: false } }),
      ]);
    } else {
      await prisma.expense.delete({ where: { id } });
    }
  } catch {
    return { ok: false, error: "Lỗi khi xoá khoản chi" };
  }

  revalidatePath("/tai-chinh");
  return { ok: true, data: undefined };
}

/** Tắt một khoản định kỳ — các Expense đã sinh trước đó không đổi. */
export async function stopRecurring(recurringId: string): Promise<ActionResult> {
  await requireUser();
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  try {
    await prisma.recurringExpense.update({ where: { id: recurringId }, data: { active: false } });
  } catch {
    return { ok: false, error: "Không tìm thấy khoản định kỳ" };
  }

  revalidatePath("/tai-chinh");
  return { ok: true, data: undefined };
}
