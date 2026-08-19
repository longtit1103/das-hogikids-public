import type { IngestAdsBody } from "./ads-schema";

/** Nguồn chi tiêu quảng cáo — CÙNG hợp đồng với body `/api/ingest/ads`. */
export type AdsSource = IngestAdsBody["source"];

/** Một dòng chi tiêu CHƯA VAT — hợp đồng chung của n8n và bước dựng lại từ kho thô. */
export type AdsSpendRow = IngestAdsBody["rows"][number];

export type PreparedAdsExpense = {
  refId: string;
  date: Date;
  /** Chính chuỗi "YYYY-MM-DD" đã neo thành `date` — dùng để so ngày mà không phải format ngược lại. */
  dateKey: string;
  description: string;
  amount: number;
};

/** Kênh của khoản chi tiêu — `Expense.channelId` phải khớp giữa hai đường ghi. */
export function adsChannelId(source: AdsSource): string {
  return source === "META" ? "facebook" : "tiktok";
}

/**
 * CÔNG THỨC DUY NHẤT của một dòng chi tiêu quảng cáo trong sổ (`Expense`, `source=ADS_API`).
 *
 * Dùng CHUNG cho hai đường ghi: `/api/ingest/ads` (n8n đẩy mỗi đêm) và bước dựng lại từ kho thô
 * (đọc báo cáo Bronze). Hai đường sinh KHÁC khoá là đẻ dòng trùng — cùng (chiến dịch, ngày) nằm ở
 * 2 dòng ⇒ chi phí quảng cáo đếm 2 lần, lãi ròng tụt mà không tra ra nguyên nhân. Nên khoá, phép
 * nhân VAT và cách neo ngày để ĐÚNG một chỗ này.
 *
 * - `refId` = `${source}:${date}:${campaignId}`; riêng TikTok Ads AUCTION mang infix `auction:`
 *   (mirror khoá Bronze ở `streams.ts`) vì cùng (chiến dịch, ngày) có thể có CẢ dòng auction lẫn
 *   GMV Max — 2 chi tiêu KHÁC nhau. GMV Max/Meta giữ khoá TRẦN để refId prod cũ không đổi.
 * - `amount = round(spendExVat × (1 + vatRate))` — làm tròn TỪNG dòng (app là biên tiền; sàn trả
 *   số chưa thuế, hộ kinh doanh không khấu trừ được VAT đầu vào).
 * - `date` neo `T00:00:00+07:00` (bất biến #3) ⇒ 1 dòng ads = 1 ngày VN.
 */
export function prepareAdsExpenseRow(source: AdsSource, row: AdsSpendRow): PreparedAdsExpense {
  return {
    refId:
      source === "TIKTOK_ADS" && row.adType === "auction"
        ? `${source}:auction:${row.date}:${row.campaignId}`
        : `${source}:${row.date}:${row.campaignId}`,
    date: new Date(`${row.date}T00:00:00+07:00`),
    dateKey: row.date,
    description: row.campaignName || row.campaignId,
    amount: Math.round(row.spendExVat * (1 + row.vatRate)),
  };
}
