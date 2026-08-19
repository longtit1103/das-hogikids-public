import { describe, expect, it } from "vitest";

import { prepareAdsExpenseRow } from "@/lib/ingest/ads-expense-row";

/**
 * Unit test THUẦN (không DB) ghim CÔNG THỨC CHUNG của một dòng chi tiêu quảng cáo — dùng cho cả
 * `/api/ingest/ads` lẫn lượt dựng lại từ kho thô.
 *
 * `refId` là khoá idempotent ĐANG SỐNG trên prod: đổi format là mọi dòng chi phí quảng cáo cũ thành
 * mồ côi và đêm sau ingest đẻ bản sao — chi phí đếm 2 lần. Nên ghim bằng chuỗi viết tay, không suy
 * lại từ chính hàm đang kiểm.
 */
const row = (extra: Record<string, unknown> = {}) => ({
  date: "2026-07-01",
  campaignId: "C1",
  campaignName: "Chiến dịch 1",
  spendExVat: 130_000,
  vatRate: 0.1,
  ...extra,
});

describe("prepareAdsExpenseRow", () => {
  it("Meta → khoá trần `META:<ngày>:<campaign>`", () => {
    expect(prepareAdsExpenseRow("META", row()).refId).toBe("META:2026-07-01:C1");
  });

  it("TikTok GMV Max (và dòng không khai loại) → khoá TRẦN, giữ nguyên refId prod cũ", () => {
    expect(prepareAdsExpenseRow("TIKTOK_ADS", row({ adType: "gmv_max" })).refId).toBe("TIKTOK_ADS:2026-07-01:C1");
    expect(prepareAdsExpenseRow("TIKTOK_ADS", row()).refId).toBe("TIKTOK_ADS:2026-07-01:C1");
  });

  it("TikTok auction → khoá mang infix `auction:` (2 loại chiến dịch = 2 khoản chi)", () => {
    expect(prepareAdsExpenseRow("TIKTOK_ADS", row({ adType: "auction" })).refId).toBe(
      "TIKTOK_ADS:auction:2026-07-01:C1"
    );
  });

  it("amount = làm tròn (chi tiêu chưa thuế × (1 + VAT)) trên TỪNG dòng", () => {
    expect(prepareAdsExpenseRow("META", row()).amount).toBe(143_000);
    expect(prepareAdsExpenseRow("META", row({ spendExVat: 81_617 })).amount).toBe(89_779);
    expect(prepareAdsExpenseRow("META", row({ vatRate: 0 })).amount).toBe(130_000);
  });

  it("ngày neo 00:00 giờ VN", () => {
    expect(prepareAdsExpenseRow("META", row()).date.toISOString()).toBe("2026-06-30T17:00:00.000Z");
  });

  it("thiếu tên chiến dịch → mô tả rơi về mã chiến dịch (không để dòng chi phí trống tên)", () => {
    expect(prepareAdsExpenseRow("META", row({ campaignName: "" })).description).toBe("C1");
  });
});
