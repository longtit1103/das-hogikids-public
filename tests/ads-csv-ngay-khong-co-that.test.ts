import { describe, expect, it } from "vitest";

import { parseAdsFile } from "@/lib/import/ads-csv";

/**
 * Ô ngày KHÔNG CÓ THẬT trong file chi tiêu ads phải thành DÒNG LỖI, tuyệt đối không được tự quy đổi.
 *
 * Vì sao phải có test này: `new Date("2026-02-31T00:00:00+07:00")` KHÔNG trả Invalid Date mà lặng lẽ
 * cho ra 03/03/2026. Không kiểm tay thì một ô gõ sai sẽ ghi chi tiêu quảng cáo sang tháng khác —
 * sai kỳ P&L mà không có lấy một cảnh báo.
 */
function csv(dong: string[]): ArrayBuffer {
  const noiDung = ["Ngày,Tên chiến dịch,Số tiền đã chi tiêu (VND)", ...dong].join("\n");
  return new TextEncoder().encode(noiDung).buffer as ArrayBuffer;
}

describe("parseAdsFile — ngày không có thật", () => {
  it("31/02 → dòng lỗi, KHÔNG tự nhảy sang 03/03", () => {
    const { rows, errors } = parseAdsFile(csv(["2026-02-31,Chiến dịch A,100000"]), "META");

    expect(rows).toHaveLength(0);
    expect(errors).toEqual([{ line: 2, reason: "Thiếu hoặc sai định dạng ngày" }]);
  });

  it("29/02 của năm KHÔNG nhuận → dòng lỗi (2026 không nhuận)", () => {
    const { rows, errors } = parseAdsFile(csv(["29/02/2026,Chiến dịch B,50000"]), "META");

    expect(rows).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  it("29/02 của năm NHUẬN vẫn hợp lệ — không được siết nhầm thành lỗi", () => {
    const { rows, errors } = parseAdsFile(csv(["2028-02-29,Chiến dịch C,70000"]), "META");

    expect(errors).toHaveLength(0);
    expect(rows).toHaveLength(1);
    expect(rows[0].date.toISOString()).toBe(new Date("2028-02-29T00:00:00+07:00").toISOString());
  });

  it("31/04 (tháng 30 ngày) → dòng lỗi; dòng hợp lệ cùng file VẪN được nhận", () => {
    const { rows, errors } = parseAdsFile(
      csv(["2026-04-31,Sai ngày,10000", "2026-04-30,Đúng ngày,20000"]),
      "META",
    );

    expect(errors).toEqual([{ line: 2, reason: "Thiếu hoặc sai định dạng ngày" }]);
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(20000);
  });

  it("tháng 13 / ngày 00 → dòng lỗi", () => {
    const { errors } = parseAdsFile(
      csv(["2026-13-01,Tháng 13,10000", "2026-05-00,Ngày 0,10000"]),
      "META",
    );

    expect(errors).toHaveLength(2);
  });
});
