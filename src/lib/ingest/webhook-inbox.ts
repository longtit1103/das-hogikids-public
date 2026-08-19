import { createHash } from "node:crypto";

import { SHOP_KHO, SHOP_SHOPEE, SHOP_TIKTOK } from "@/lib/bronze/streams";
import { prisma } from "@/lib/prisma";

/**
 * Hộp thư THÔ webhook Pancake POS — nơi DUY NHẤT ghi vào `RawPancakeWebhookEvent`.
 * Endpoint nhận (`/api/ingest/webhook/[shop]`) và script nạp bù dùng chung hàm này để
 * luật băm/dedupe chỉ có một bản.
 *
 * Nguyên tắc: NHẬN LÀ GHI. Không parse, không sniff loại sự kiện, không đụng Silver.
 * App chưa hiểu shape cũng phải giữ được payload — mất raw là mất vĩnh viễn (Pancake
 * không có API lấy lại lịch sử sự kiện).
 */

/** Slug trên URL endpoint → shop id Pancake. Whitelist: slug lạ bị từ chối, không đoán. */
export const SHOP_ID_THEO_SLUG: Readonly<Record<string, string>> = {
  kho: SHOP_KHO,
  shopee: SHOP_SHOPEE,
  tiktok: SHOP_TIKTOK,
};

/** Trần payload 5MB — sự kiện thật ~10–30KB; chặn body khổng lồ trước khi đụng Postgres. */
export const MAX_WEBHOOK_PAYLOAD = 5_000_000;

/** Đường vào của một dòng: bắn thẳng từ n8n, hay nạp bù từ file mẫu / bảng hệ cũ. */
export type NguonSuKien = "webhook" | "file" | "db-cu";

export function bamPayload(payload: string): string {
  return createHash("md5").update(payload, "utf8").digest("hex");
}

/**
 * Ghi một sự kiện vào hộp thư. `daGhi=false` khi trùng khoá (shop + mốc nhận + băm) —
 * chỉ xảy ra lúc chạy lại script nạp bù, KHÔNG phải lỗi. `id` trả về để pha 2 ghi kết cục
 * xử lý (`processedAs`) vào ĐÚNG dòng vừa tạo — payload gốc không bao giờ bị sửa.
 */
export async function luuSuKienWebhook(args: {
  shopId: string;
  payload: string;
  receivedAt?: Date;
  source?: NguonSuKien;
}): Promise<{ daGhi: boolean; id: string | null }> {
  const { shopId, payload, receivedAt, source = "webhook" } = args;
  try {
    const dong = await prisma.rawPancakeWebhookEvent.create({
      data: {
        shopId,
        payload,
        payloadHash: bamPayload(payload),
        source,
        ...(receivedAt ? { receivedAt } : {}),
      },
    });
    return { daGhi: true, id: dong.id };
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002") {
      return { daGhi: false, id: null };
    }
    throw err;
  }
}
