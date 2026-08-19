import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// INGEST_SECRET phải set TRƯỚC khi gọi handler (requireIngestSecret đọc process.env lúc chạy).
const SECRET = "test-ingest-secret";
process.env.INGEST_SECRET = SECRET;

import { POST as adsPost } from "@/app/api/ingest/ads/route";
import { POST as backupLogPost } from "@/app/api/ingest/backup-log/route";
import { thuGiuKhoaPhucHoi } from "@/lib/backup/khoa-bao-tri";
import { prisma } from "@/lib/prisma";
import { donKhoaPhucHoi } from "../helpers/khoa-bao-tri-reset";

/** Integration test route ads + backup-log — chạy trên DB test `hogikids_test`. */

const makeReq = (url: string, body: unknown, secret: string | null = SECRET) =>
  new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  await prisma.channel.upsert({
    where: { id: "facebook" },
    create: { id: "facebook", name: "Facebook", color: "#5db8a6", sortOrder: 3 },
    update: {},
  });
  await prisma.channel.upsert({
    where: { id: "tiktok" },
    create: { id: "tiktok", name: "TikTok", color: "#141413", sortOrder: 2 },
    update: {},
  });
  await prisma.expenseCategory.upsert({
    where: { id: "ads" },
    create: { id: "ads", name: "Quảng cáo", isSystem: true },
    update: {},
  });
  // Dọn MỌI chi phí quảng cáo, không riêng dòng ADS_API: cổng ghi của route còn soi cả dòng
  // `IMPORT` (ngày chủ shop đã ghi đè bằng file thì lượt đêm không được ghi lại). Suite import CSV
  // chạy trước để lại dòng IMPORT đúng những ngày dùng ở đây ⇒ không dọn là đỏ ngẫu nhiên theo
  // thứ tự file.
  await prisma.expense.deleteMany({ where: { categoryId: "ads" } });
}, 60_000);

afterAll(async () => {
  await prisma.expense.deleteMany({ where: { categoryId: "ads" } });
  await prisma.$disconnect();
});

describe("POST /api/ingest/ads", () => {
  it("sai bearer → 401", async () => {
    const res = await adsPost(makeReq("http://t/api/ingest/ads", { source: "META", rows: [] }, "wrong"));
    expect(res.status).toBe(401);
  });

  it("META rows → nhân VAT ở app: spendExVat=130000, vatRate=0.1 → amount=143000, neo ngày +07, channel facebook", async () => {
    const res = await adsPost(
      makeReq("http://t/api/ingest/ads", {
        source: "META",
        rows: [{ date: "2026-07-01", campaignId: "C1", campaignName: "Chiến dịch 1", spendExVat: 130000, vatRate: 0.1 }],
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; stats: { rowsUpserted: number } };
    expect(json.ok).toBe(true);
    expect(json.stats.rowsUpserted).toBe(1);

    const exp = await prisma.expense.findUnique({ where: { refId: "META:2026-07-01:C1" } });
    expect(exp).not.toBeNull();
    expect(exp!.amount).toBe(143000); // 130000 × 1.1 = 143000 (VAT nhân ở app)
    expect(exp!.channelId).toBe("facebook");
    expect(exp!.categoryId).toBe("ads");
    expect(exp!.adsSource).toBe("META");
    expect(exp!.date.toISOString()).toBe("2026-06-30T17:00:00.000Z"); // 2026-07-01 00:00 +07 = 17:00Z hôm trước
  });

  it("vatRate=0 → amount = spendExVat (không cộng thuế)", async () => {
    const res = await adsPost(
      makeReq("http://t/api/ingest/ads", {
        source: "META",
        rows: [{ date: "2026-07-03", campaignId: "C0", campaignName: "Miễn thuế", spendExVat: 200000, vatRate: 0 }],
      }),
    );
    expect(res.status).toBe(200);
    const exp = await prisma.expense.findUnique({ where: { refId: "META:2026-07-03:C0" } });
    expect(exp!.amount).toBe(200000);
  });

  it("POST lại cùng refId, spendExVat khác → idempotent (1 Expense, amount cập nhật)", async () => {
    await adsPost(
      makeReq("http://t/api/ingest/ads", {
        source: "META",
        rows: [{ date: "2026-07-01", campaignId: "C1", campaignName: "Chiến dịch 1 (đổi)", spendExVat: 250000, vatRate: 0.1 }],
      }),
    );
    const rows = await prisma.expense.findMany({ where: { refId: "META:2026-07-01:C1" } });
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(275000); // 250000 × 1.1
    expect(rows[0].description).toBe("Chiến dịch 1 (đổi)");
  });

  it("2 dòng cùng refId trong 1 payload → THROW (500), KHÔNG ghi Expense nào", async () => {
    const res = await adsPost(
      makeReq("http://t/api/ingest/ads", {
        source: "META",
        rows: [
          { date: "2026-07-09", campaignId: "DUP", campaignName: "auction", spendExVat: 10000, vatRate: 0.1 },
          { date: "2026-07-09", campaignId: "DUP", campaignName: "gmvmax", spendExVat: 20000, vatRate: 0.1 },
        ],
      }),
    );
    expect(res.status).toBe(500);
    const json = (await res.json()) as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/refId trùng/);
    // Không ghi lô nửa vời: refId trùng bị chặn TRƯỚC transaction.
    expect(await prisma.expense.findUnique({ where: { refId: "META:2026-07-09:DUP" } })).toBeNull();
    const log = await prisma.syncLog.findFirst({ where: { kind: "META_ADS" }, orderBy: { startedAt: "desc" } });
    expect(log!.status).toBe("ERROR");
  });

  it("thiếu vatRate → 400 (không mặc định 0, tránh ghi thiếu VAT âm thầm)", async () => {
    const res = await adsPost(
      makeReq("http://t/api/ingest/ads", {
        source: "META",
        rows: [{ date: "2026-07-10", campaignId: "NOVAT", spendExVat: 50000 }],
      }),
    );
    expect(res.status).toBe(400);
    expect(await prisma.expense.findUnique({ where: { refId: "META:2026-07-10:NOVAT" } })).toBeNull();
  });

  it("TIKTOK_ADS: 2 dòng cùng (campaign, ngày) khác adType → refId KHÁC nhau, CẢ 2 upsert không throw", async () => {
    const res = await adsPost(
      makeReq("http://t/api/ingest/ads", {
        source: "TIKTOK_ADS",
        rows: [
          { date: "2026-07-11", campaignId: "MIX", campaignName: "Đấu giá", adType: "auction", spendExVat: 10000, vatRate: 0.1 },
          { date: "2026-07-11", campaignId: "MIX", campaignName: "GMV Max", adType: "gmv_max", spendExVat: 20000, vatRate: 0.1 },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; stats: { rowsUpserted: number } };
    expect(json.ok).toBe(true);
    expect(json.stats.rowsUpserted).toBe(2);

    // auction mang infix "auction:" (mirror Bronze); gmv_max giữ khoá TRẦN (= refId prod cũ).
    const auction = await prisma.expense.findUnique({ where: { refId: "TIKTOK_ADS:auction:2026-07-11:MIX" } });
    const gmvMax = await prisma.expense.findUnique({ where: { refId: "TIKTOK_ADS:2026-07-11:MIX" } });
    expect(auction!.amount).toBe(11000); // 10000 × 1.1
    expect(gmvMax!.amount).toBe(22000); // 20000 × 1.1
  });

  it("TIKTOK_ADS: POST lại dòng auction cùng khoá → idempotent (1 Expense, amount cập nhật)", async () => {
    await adsPost(
      makeReq("http://t/api/ingest/ads", {
        source: "TIKTOK_ADS",
        rows: [{ date: "2026-07-11", campaignId: "MIX", campaignName: "Đấu giá (đổi)", adType: "auction", spendExVat: 30000, vatRate: 0.1 }],
      }),
    );
    const rows = await prisma.expense.findMany({ where: { refId: "TIKTOK_ADS:auction:2026-07-11:MIX" } });
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(33000); // 30000 × 1.1
  });

  it("TIKTOK_ADS: 2 dòng CÙNG adType trùng (campaign, ngày) → vẫn THROW 500, không ghi", async () => {
    const res = await adsPost(
      makeReq("http://t/api/ingest/ads", {
        source: "TIKTOK_ADS",
        rows: [
          { date: "2026-07-12", campaignId: "DUP2", adType: "gmv_max", spendExVat: 10000, vatRate: 0.1 },
          { date: "2026-07-12", campaignId: "DUP2", adType: "gmv_max", spendExVat: 20000, vatRate: 0.1 },
        ],
      }),
    );
    expect(res.status).toBe(500);
    const json = (await res.json()) as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/refId trùng/);
    expect(await prisma.expense.findUnique({ where: { refId: "TIKTOK_ADS:2026-07-12:DUP2" } })).toBeNull();
  });

  it("META: adType bị bỏ qua — refId luôn khoá TRẦN (Meta không có GMV Max)", async () => {
    const res = await adsPost(
      makeReq("http://t/api/ingest/ads", {
        source: "META",
        rows: [{ date: "2026-07-11", campaignId: "M1", adType: "auction", spendExVat: 10000, vatRate: 0.1 }],
      }),
    );
    expect(res.status).toBe(200);
    expect(await prisma.expense.findUnique({ where: { refId: "META:2026-07-11:M1" } })).not.toBeNull();
    expect(await prisma.expense.findUnique({ where: { refId: "META:auction:2026-07-11:M1" } })).toBeNull();
  });

  it("TIKTOK_ADS → channel tiktok + SyncLog kind TIKTOK_ADS OK", async () => {
    const res = await adsPost(
      makeReq("http://t/api/ingest/ads", {
        source: "TIKTOK_ADS",
        rows: [{ date: "2026-07-02", campaignId: "TT9", spendExVat: 50000, vatRate: 0.1 }],
      }),
    );
    expect(res.status).toBe(200);
    const exp = await prisma.expense.findUnique({ where: { refId: "TIKTOK_ADS:2026-07-02:TT9" } });
    expect(exp!.channelId).toBe("tiktok");
    expect(exp!.amount).toBe(55000); // 50000 × 1.1
    const log = await prisma.syncLog.findFirst({ where: { kind: "TIKTOK_ADS" }, orderBy: { startedAt: "desc" } });
    expect(log!.status).toBe("OK");
  });
});

describe("POST /api/ingest/backup-log", () => {
  afterEach(() => {
    donKhoaPhucHoi();
  });

  it("sai bearer → 401", async () => {
    const res = await backupLogPost(makeReq("http://t/api/ingest/backup-log", { status: "OK" }, null));
    expect(res.status).toBe(401);
  });

  it("OK → tạo SyncLog kind BACKUP status OK + stats", async () => {
    const res = await backupLogPost(
      makeReq("http://t/api/ingest/backup-log", {
        status: "OK",
        stats: { file: "hogikids-260707.dump", sizeBytes: 12345, drivePath: "cloud:backups/" },
      }),
    );
    expect(res.status).toBe(200);
    const log = await prisma.syncLog.findFirst({ where: { kind: "BACKUP" }, orderBy: { startedAt: "desc" } });
    expect(log!.status).toBe("OK");
    expect(log!.finishedAt).not.toBeNull();
    expect((log!.stats as { file: string }).file).toBe("hogikids-260707.dump");
  });

  it("đang phục hồi → 503, KHÔNG đẻ dòng SyncLog (cron host thấy lỗi thay vì mất dấu lặng)", async () => {
    const truoc = await prisma.syncLog.count({ where: { kind: "BACKUP" } });
    expect(thuGiuKhoaPhucHoi()).not.toBeNull();

    const res = await backupLogPost(
      makeReq("http://t/api/ingest/backup-log", {
        status: "OK",
        stats: { file: "hogikids-260730.dump", sizeBytes: 999, drivePath: "cloud:backups/" },
      }),
    );

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(await prisma.syncLog.count({ where: { kind: "BACKUP" } })).toBe(truoc);
  });
});
