import { format } from "date-fns";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { quangCaoTheoChienDich } from "@/lib/reports/quang-cao-chien-dich";

import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * Bảng hiệu quả quảng cáo theo chiến dịch (`hogikids_test`).
 *
 * Hai thứ lưới này phải giữ:
 *  1. Tiền KHỚP sổ chi phí — bảng marketing không được đẻ ra con số thứ hai cho
 *     cùng một khoản chi (lớp lỗi "đuổi theo số ở hai nơi" repo đã dính nhiều lần).
 *  2. Thiếu chỉ số phải ra `null` chứ KHÔNG ra 0 — TikTok không trả impressions,
 *     hiện 0 là nói dối rằng đã đo được và bằng không.
 */

const RANGE = { from: new Date("2026-05-01T00:00:00+07:00"), to: new Date("2026-05-31T00:00:00+07:00") };
const TRONG_KY = new Date("2026-05-15T00:00:00+07:00");
const NGOAI_KY = new Date("2026-04-15T00:00:00+07:00");

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.rawMetaAdsReport.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function taoChiAds(opts: {
  nguon: string;
  campaignId: string | null;
  ten: string;
  amount: number;
  date?: Date;
}): Promise<void> {
  const d = opts.date ?? TRONG_KY;
  const ngay = format(d, "yyyy-MM-dd");
  await prisma.expense.create({
    data: {
      date: d,
      categoryId: "ads",
      adsSource: opts.nguon,
      description: opts.ten,
      amount: opts.amount,
      source: "ADS_API",
      // campaignId null ⇒ refId NULL, đúng như `ads-import.ts` ghi cho dòng file /
      // nhập tay. Bản cũ dựng chuỗi 2 mảnh `"META:{ngày}"` — khuôn KHÔNG tồn tại ở
      // prod (đo 18/08: mọi refId đúng 3 mảnh) và còn đụng unique constraint refId.
      refId: opts.campaignId ? `${opts.nguon}:${ngay}:${opts.campaignId}` : null,
    },
  });
}

async function taoChiSoMeta(opts: {
  campaignId: string;
  externalId: string;
  impressions: number;
  clicks: number;
  date?: Date;
  fetchedAt?: Date;
}): Promise<void> {
  // format() theo giờ ĐỊA PHƯƠNG (container + dev đều +07). Bản cũ dùng
  // toISOString() nên 15/05 00:00+07 ra "2026-05-14" — fixture tự trộn UTC vào một
  // app neo +07, và chính chỗ đó làm bộ test mù trước lỗi biên ngày.
  const ngay = format(opts.date ?? TRONG_KY, "yyyy-MM-dd");
  await prisma.rawMetaAdsReport.create({
    data: {
      shopId: "meta",
      externalId: opts.externalId,
      payloadHash: `h-${opts.externalId}-${opts.impressions}`,
      fetchedAt: opts.fetchedAt ?? new Date(),
      payload: {
        campaign_id: opts.campaignId,
        campaign_name: `CD ${opts.campaignId}`,
        date_start: ngay,
        date_stop: ngay,
        impressions: String(opts.impressions),
        clicks: String(opts.clicks),
        spend: "0",
      },
    },
  });
}

describe("quangCaoTheoChienDich", () => {
  it("Meta: gom đúng chi tiêu + tính CTR/CPM/CPC từ tiền của sổ", async () => {
    await taoChiAds({ nguon: "META", campaignId: "C1", ten: "Váy hè", amount: 1_000_000 });
    await taoChiSoMeta({ campaignId: "C1", externalId: "m-1", impressions: 100_000, clicks: 2_000 });

    const r = await quangCaoTheoChienDich(RANGE);

    expect(r.chienDich).toHaveLength(1);
    const c = r.chienDich[0];
    expect(c.chiTieu).toBe(1_000_000);
    expect(c.hienThi).toBe(100_000);
    expect(c.click).toBe(2_000);
    expect(c.ctr).toBeCloseTo(2, 6); // 2000/100000 × 100
    expect(c.cpm).toBeCloseTo(10_000, 6); // 1.000.000/100.000 × 1000
    expect(c.cpc).toBeCloseTo(500, 6); // 1.000.000/2.000
    expect(r.tongChiTieu).toBe(1_000_000);
  });

  it("nguồn KHÔNG có chỉ số trả null chứ không trả 0", async () => {
    await taoChiAds({ nguon: "TIKTOK_ADS", campaignId: "T1", ten: "Bộ bà ba", amount: 500_000 });

    const r = await quangCaoTheoChienDich(RANGE);

    const c = r.chienDich[0];
    expect(c.hienThi).toBeNull();
    expect(c.click).toBeNull();
    expect(c.ctr).toBeNull();
    expect(c.cpm).toBeNull();
    expect(c.cpc).toBeNull();
    expect(r.nguonThieuChiSo).toEqual(["TIKTOK_ADS"]);
    expect(r.nguonCoChiSo).toEqual([]);
  });

  it("hiển thị = 0 thì CTR/CPM là null, KHÔNG chia cho 0", async () => {
    await taoChiAds({ nguon: "META", campaignId: "C0", ten: "Chưa chạy", amount: 100_000 });
    await taoChiSoMeta({ campaignId: "C0", externalId: "m-0", impressions: 0, clicks: 0 });

    const r = await quangCaoTheoChienDich(RANGE);

    const c = r.chienDich[0];
    expect(c.hienThi).toBe(0);
    expect(c.ctr).toBeNull();
    expect(c.cpm).toBeNull();
    expect(c.cpc).toBeNull();
  });

  it("dòng Meta BẮN LẠI chỉ tính bản mới nhất — cộng cả hai là chỉ số phồng lên", async () => {
    await taoChiAds({ nguon: "META", campaignId: "C2", ten: "Set nâu", amount: 200_000 });
    await taoChiSoMeta({ campaignId: "C2", externalId: "m-2", impressions: 1_000, clicks: 10, fetchedAt: new Date("2026-05-20") });
    await taoChiSoMeta({ campaignId: "C2", externalId: "m-2", impressions: 3_000, clicks: 30, fetchedAt: new Date("2026-05-21") });

    const r = await quangCaoTheoChienDich(RANGE);

    expect(r.chienDich[0].hienThi).toBe(3_000);
    expect(r.chienDich[0].click).toBe(30);
  });

  it("nhiều dòng ads KHÔNG có mã chiến dịch: gộp 1 dòng nhãn cố định, KHÔNG mượn tên chiến dịch", async () => {
    // ads-import.ts ghi refId=null cho mọi dòng của file. Mượn description của một
    // dòng bất kỳ = nói với chủ shop rằng chiến dịch đó tiêu cả cụm tiền.
    await taoChiAds({ nguon: "META", campaignId: null, ten: "Váy hè – Retarget", amount: 400_000 });
    await taoChiAds({ nguon: "META", campaignId: null, ten: "Set nâu – Prospecting", amount: 377_000 });

    const r = await quangCaoTheoChienDich(RANGE);

    expect(r.tongChiTieu).toBe(777_000); // tiền KHÔNG được biến mất
    expect(r.chienDich).toHaveLength(1);
    const c = r.chienDich[0];
    expect(c.campaignId).toBe("");
    expect(c.khongRoChienDich).toBe(true);
    expect(c.soDongGop).toBe(2);
    expect(c.ten).toBe("(không rõ chiến dịch)");
    expect(c.ten).not.toContain("Váy hè");
    expect(c.ten).not.toContain("Set nâu");
  });

  it("refId TikTok ĐẤU GIÁ có 4 mảnh — vẫn tách đúng từng chiến dịch", async () => {
    // prepareAdsExpenseRow sinh "TIKTOK_ADS:auction:{ngày}:{campaignId}". Lấy mảnh
    // thứ 3 sẽ nhặt được NGÀY ⇒ mọi chiến dịch đấu giá cùng ngày gộp thành 1 dòng
    // mà tổng vẫn đúng nên không có tín hiệu nào báo sai.
    const ngay = format(TRONG_KY, "yyyy-MM-dd");
    for (const [cid, tien] of [["A1", 300_000], ["B2", 200_000], ["C3", 100_000]] as [string, number][]) {
      await prisma.expense.create({
        data: {
          date: TRONG_KY, categoryId: "ads", adsSource: "TIKTOK_ADS",
          description: `Đấu giá ${cid}`, amount: tien, source: "ADS_API",
          refId: `TIKTOK_ADS:auction:${ngay}:${cid}`,
        },
      });
    }

    const r = await quangCaoTheoChienDich(RANGE);

    expect(r.chienDich).toHaveLength(3);
    expect(r.chienDich.map((c) => c.campaignId)).toEqual(["A1", "B2", "C3"]);
    expect(r.chienDich.map((c) => c.chiTieu)).toEqual([300_000, 200_000, 100_000]);
    expect(r.chienDich.every((c) => !c.khongRoChienDich)).toBe(true);
  });

  it("chỉ số Meta NGOÀI kỳ bị loại — biên ngày không được lệch một ngày", async () => {
    // Ca này khoá lỗi ép `${Date}::date` trong SQL: session Postgres là UTC nên
    // mốc 01/05 00:00+07 bị dịch thành 2026-04-30, kéo thêm một ngày vào đầu kỳ ⇒
    // hiển thị/click phồng lên, CPM/CPC rẻ đi mà không có dấu hiệu gì.
    await taoChiAds({ nguon: "META", campaignId: "CB", ten: "Biên kỳ", amount: 1_000_000 });
    await taoChiSoMeta({ campaignId: "CB", externalId: "m-trong", impressions: 100_000, clicks: 1_000 });
    await taoChiSoMeta({
      campaignId: "CB", externalId: "m-truoc-1-ngay", impressions: 999_999, clicks: 9_999,
      date: new Date("2026-04-30T00:00:00+07:00"),
    });
    await taoChiSoMeta({
      campaignId: "CB", externalId: "m-sau-1-ngay", impressions: 888_888, clicks: 8_888,
      date: new Date("2026-06-01T00:00:00+07:00"),
    });

    const r = await quangCaoTheoChienDich(RANGE);

    expect(r.chienDich[0].hienThi).toBe(100_000);
    expect(r.chienDich[0].click).toBe(1_000);
    expect(r.chienDich[0].cpm).toBeCloseTo(10_000, 6);
  });

  it("cùng campaignId ở HAI nguồn: tách 2 dòng, dòng TikTok KHÔNG mượn chỉ số của Meta", async () => {
    await taoChiAds({ nguon: "META", campaignId: "XX", ten: "Meta XX", amount: 200_000 });
    await taoChiAds({ nguon: "TIKTOK_ADS", campaignId: "XX", ten: "TikTok XX", amount: 100_000 });
    await taoChiSoMeta({ campaignId: "XX", externalId: "m-xx", impressions: 50_000, clicks: 500 });

    const r = await quangCaoTheoChienDich(RANGE);

    expect(r.chienDich).toHaveLength(2);
    const meta = r.chienDich.find((c) => c.nguon === "META")!;
    const tiktok = r.chienDich.find((c) => c.nguon === "TIKTOK_ADS")!;
    expect(meta.hienThi).toBe(50_000);
    expect(tiktok.hienThi).toBeNull();
  });

  it("nguồn CÓ chỉ số không bị gắn nhãn 'thiếu chỉ số' chỉ vì một dòng không tra được", async () => {
    // Trộn: 1 dòng Meta có chỉ số + 1 dòng Meta nhập tay (refId null). META phải
    // nằm ở nguonCoChiSo và KHÔNG nằm ở nguonThieuChiSo, kẻo chú thích chân bảng
    // nói "Meta chưa trả chỉ số" ngay trên mấy dòng Meta đang hiện đủ số.
    await taoChiAds({ nguon: "META", campaignId: "CM", ten: "Có số", amount: 100_000 });
    await taoChiSoMeta({ campaignId: "CM", externalId: "m-cm", impressions: 10_000, clicks: 100 });
    await taoChiAds({ nguon: "META", campaignId: null, ten: "Gõ tay", amount: 50_000 });

    const r = await quangCaoTheoChienDich(RANGE);

    expect(r.nguonCoChiSo).toEqual(["META"]);
    expect(r.nguonThieuChiSo).toEqual([]);
  });

  it("chỉ lấy chi phí TRONG kỳ", async () => {
    await taoChiAds({ nguon: "META", campaignId: "C3", ten: "Trong kỳ", amount: 100_000 });
    await taoChiAds({ nguon: "META", campaignId: "C4", ten: "Ngoài kỳ", amount: 900_000, date: NGOAI_KY });

    const r = await quangCaoTheoChienDich(RANGE);

    expect(r.tongChiTieu).toBe(100_000);
    expect(r.chienDich.map((c) => c.ten)).toEqual(["Trong kỳ"]);
  });

  it("xếp theo chi tiêu giảm dần", async () => {
    await taoChiAds({ nguon: "META", campaignId: "A", ten: "A", amount: 100_000 });
    await taoChiAds({ nguon: "META", campaignId: "B", ten: "B", amount: 900_000 });
    await taoChiAds({ nguon: "TIKTOK_ADS", campaignId: "C", ten: "C", amount: 500_000 });

    const r = await quangCaoTheoChienDich(RANGE);

    expect(r.chienDich.map((c) => c.ten)).toEqual(["B", "C", "A"]);
  });

  it("chỉ đếm danh mục ads — chi phí khác không lọt vào bảng marketing", async () => {
    await prisma.expense.create({
      data: { date: TRONG_KY, categoryId: "shipping", description: "Ship", amount: 5_000_000, source: "MANUAL" },
    });
    await taoChiAds({ nguon: "META", campaignId: "C5", ten: "Ads thật", amount: 100_000 });

    const r = await quangCaoTheoChienDich(RANGE);

    expect(r.tongChiTieu).toBe(100_000);
    expect(r.chienDich).toHaveLength(1);
  });
});
