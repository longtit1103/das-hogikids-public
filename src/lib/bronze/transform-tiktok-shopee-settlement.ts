import { mapShopeeWallet } from "@/lib/ingest/shopee-settlement-mapping";
import { upsertOneShopeeSettlement } from "@/lib/ingest/shopee-settlement-upsert";
import {
  mapAdsTxn,
  mapPayment,
  mapStatement,
} from "@/lib/ingest/tiktok-settlement-mapping";
import {
  upsertOneAdsSettlement,
  upsertOnePayment,
  upsertOneSettlement,
} from "@/lib/ingest/tiktok-settlement-upsert";

import { SHOP_SHOPEE, SHOP_TIKTOK_SHOP } from "./streams";
import {
  chamMoc,
  latestAdsPayloads,
  latestPayloads,
  type TransformOptions,
  type TransformStats,
} from "./transform-raw-helpers";

/**
 * Nhánh "Tiền đã về" của transform (TikTok Shop settlement + ví Shopee). Dòng tiền ĐỐI CHIẾU,
 * ĐỘC LẬP P&L/doanh thu (bất biến #2) — tuyệt đối không lấy số ở đây sửa phí trong P&L.
 * Gọi từ `transform-from-raw.ts`.
 */

/** TikTok Shop statement → Silver `TiktokSettlement`. Chỉ shop TikTok Shop. */
export async function transformTiktokStatements(
  stats: TransformStats,
  warnings: string[],
  opts: TransformOptions,
): Promise<void> {
  const { externalIds, checkpoint } = opts;
  let iSt = 0;
  for (const row of await latestPayloads("RawTiktokShopStatement", {
    shopId: SHOP_TIKTOK_SHOP,
    externalIds,
  })) {
    await chamMoc(checkpoint, iSt++);
    const m = mapStatement(row.externalId, row.shopId, row.payload);
    if (!m) {
      stats.skipped++;
      warnings.push(
        `Bỏ qua statement ${row.externalId}: payload thiếu statement_time / hỏng shape`,
      );
      continue;
    }
    await upsertOneSettlement(m, row.payload, stats, warnings);
  }
}

/** Khoản trừ tiền quảng cáo trong statement → Silver `TiktokAdsSettlement`. */
export async function transformTiktokAdsTxns(
  stats: TransformStats,
  warnings: string[],
  opts: TransformOptions,
): Promise<void> {
  const { externalIds, checkpoint } = opts;
  // [C2] Ads nhận diện cross-version (chống re-fetch rớt `type`) — xem latestAdsPayloads.
  let iTx = 0;
  for (const row of await latestAdsPayloads({
    shopId: SHOP_TIKTOK_SHOP,
    externalIds,
  })) {
    await chamMoc(checkpoint, iTx++);
    const m = mapAdsTxn(row.externalId, row.shopId, row.payload);
    if (!m) {
      stats.skipped++;
      warnings.push(
        `Bỏ qua ads-txn ${row.externalId}: payload thiếu order_create_time / hỏng shape`,
      );
      continue;
    }
    await upsertOneAdsSettlement(m, row.payload, stats, warnings);
  }
}

/** Lệnh rút tiền TikTok Shop → Silver `TiktokPayment`. */
export async function transformTiktokPayments(
  stats: TransformStats,
  warnings: string[],
  opts: TransformOptions,
): Promise<void> {
  const { externalIds, checkpoint } = opts;
  let iPay = 0;
  for (const row of await latestPayloads("RawTiktokShopPayment", {
    shopId: SHOP_TIKTOK_SHOP,
    externalIds,
  })) {
    await chamMoc(checkpoint, iPay++);
    const m = mapPayment(row.externalId, row.shopId, row.payload);
    if (!m) {
      stats.skipped++;
      warnings.push(`Bỏ qua payment ${row.externalId}: payload hỏng shape`);
      continue;
    }
    // PAID mà thiếu paid_time: card "Đã rút về bank" lọc `status=PAID AND paidTime ∈ kỳ`, mà
    // paidTime NULL bị filter ngày loại ở MỌI kỳ — lệnh rút biến mất khỏi hiển thị trong im
    // lặng. Vẫn ghi Silver (giữ dữ liệu thật, không đoán ngày thay sàn) nhưng phải kêu to.
    if (m.status === "PAID" && !m.paidTime) {
      warnings.push(
        `Payment ${m.paymentId} trạng thái PAID nhưng THIẾU paid_time — sẽ không hiện vào ` +
          `"Đã rút về bank" ở bất kỳ kỳ nào. Kiểm payload TikTok của lệnh rút này.`,
      );
    }
    await upsertOnePayment(m, row.payload, stats, warnings);
  }
}

/** Ví Shopee (import file tay) → Silver `ShopeeSettlement`. Chỉ shop Shopee (SHOP_SHOPEE). */
export async function transformShopeeWallet(
  stats: TransformStats,
  warnings: string[],
  opts: TransformOptions,
): Promise<void> {
  const { externalIds, checkpoint } = opts;
  let iSh = 0;
  for (const row of await latestPayloads("RawShopeeWalletTxn", {
    shopId: SHOP_SHOPEE,
    externalIds,
  })) {
    await chamMoc(checkpoint, iSh++);
    const m = mapShopeeWallet(row.externalId, row.shopId, row.payload);
    if (!m) {
      stats.skipped++;
      warnings.push(
        `Bỏ qua shopee-txn ${row.externalId}: payload thiếu txnTime/amount / hỏng shape`,
      );
      continue;
    }
    await upsertOneShopeeSettlement(m, row.payload, stats, warnings);
  }
}
