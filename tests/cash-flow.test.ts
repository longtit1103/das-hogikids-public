import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { computeCashFlow, sumGmv } from "@/lib/reports/cash-flow";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * Integration test lăng kính Dòng tiền (`hogikids_test`). Kỳ cố định 6/2026.
 * Bất biến kiểm: tiền vào = ĐƠN ĐÃ GIAO (COMPLETED); PENDING/SHIPPING = đang
 * chờ (KHÔNG vào số dư); tiền ra GỒM Nhập hàng (purchase); GMV gồm cả đơn hủy.
 */

const RANGE = { from: new Date(2026, 5, 1), to: new Date(2026, 5, 30) };
const IN_RANGE = new Date(2026, 5, 15);

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function seed(): Promise<void> {
  await prisma.expense.createMany({
    data: [
      { date: IN_RANGE, categoryId: "purchase", description: "Nhập hàng", amount: 5_000_000, source: "MANUAL" },
      { date: IN_RANGE, categoryId: "ads", description: "Meta Ads", amount: 2_000_000, source: "ADS_API", adsSource: "META" },
    ],
  });
  await prisma.order.createMany({
    data: [
      {
        pancakeId: "CF-COMPLETED", code: "C1", channelId: "shopee", status: "COMPLETED",
        orderedAt: IN_RANGE, syncedAt: IN_RANGE, itemsTotal: 500_000, discount: 20_000, platformFeeEst: 62_500,
      },
      {
        pancakeId: "CF-SHIPPING", code: "C2", channelId: "shopee", status: "SHIPPING",
        orderedAt: IN_RANGE, syncedAt: IN_RANGE, itemsTotal: 300_000, discount: 0, platformFeeEst: 30_000,
      },
      {
        pancakeId: "CF-CANCELLED", code: "C3", channelId: "shopee", status: "CANCELLED",
        orderedAt: IN_RANGE, syncedAt: IN_RANGE, itemsTotal: 999_000, discount: 0, platformFeeEst: 0,
      },
    ],
  });
}

describe("computeCashFlow — dòng tiền dự kiến", () => {
  it("vào = COMPLETED; đang chờ = SHIPPING; ra gồm Nhập hàng; số dư & actualIn", async () => {
    await seed();
    const cf = await computeCashFlow(RANGE);

    expect(cf.expectedIn).toBe(417_500); // 500.000 − 62.500 − 20.000 (chỉ COMPLETED)
    expect(cf.pendingIn).toBe(270_000); // 300.000 − 30.000 (SHIPPING; CANCELLED bị loại)
    expect(cf.pendingCount).toBe(1);
    expect(cf.cashOut).toBe(7_000_000); // Nhập hàng 5tr + ads 2tr (GỒM Nhập hàng)
    expect(cf.balance).toBe(417_500 - 7_000_000);
    expect(cf.actualIn.tiktok).toBeNull();
    expect(cf.actualIn.shopee).toBeNull();
    expect(cf.outBreakdown.some((b) => b.categoryId === "purchase")).toBe(true);
  });
});

describe("sumGmv — doanh số", () => {
  it("gồm MỌI đơn kể cả hủy (khác doanh thu)", async () => {
    await seed();
    // 500.000 + 300.000 + 999.000 (cancelled) = 1.799.000
    expect(await sumGmv(RANGE)).toBe(1_799_000);
  });
});

describe("computeCashFlow — actualIn (Tiền đã về TikTok)", () => {
  it("net + adsDeducted(|Σ|) + bankPaid(chỉ PAID); độc lập expectedIn/cashOut", async () => {
    await prisma.tiktokSettlement.createMany({
      data: [
        { statementId: "S1", shopId: "T", statementTime: IN_RANGE, paymentStatus: "SETTLED", settlementAmount: 1_000_000, revenueAmount: 0, feeAmount: 0, adjustmentAmount: 0, netSalesAmount: 0, shippingCostAmount: 0 },
        { statementId: "S2", shopId: "T", statementTime: IN_RANGE, paymentStatus: "SETTLED", settlementAmount: 500_000, revenueAmount: 0, feeAmount: 0, adjustmentAmount: 0, netSalesAmount: 0, shippingCostAmount: 0 },
      ],
    });
    await prisma.tiktokAdsSettlement.create({
      data: { transactionId: "A1", shopId: "T", orderCreateTime: IN_RANGE, settlementAmount: -200_000 },
    });
    await prisma.tiktokPayment.createMany({
      data: [
        { paymentId: "P1", shopId: "T", status: "PAID", paidTime: IN_RANGE, settlementValue: 1_800_000, amountValue: 1_800_000 },
        { paymentId: "P2", shopId: "T", status: "FAILED", paidTime: IN_RANGE, settlementValue: 999_000, amountValue: 999_000 }, // loại (không PAID)
      ],
    });

    const cf = await computeCashFlow(RANGE);
    expect(cf.actualIn.tiktok).not.toBeNull();
    expect(cf.actualIn.tiktok!.net).toBe(1_500_000);
    expect(cf.actualIn.tiktok!.adsDeducted).toBe(200_000); // |Σ ads| (âm → dương)
    expect(cf.actualIn.tiktok!.bankPaid).toBe(1_800_000); // chỉ PAID
    expect(cf.actualIn.tiktok!.channel).toBe("tiktok");
    expect(cf.actualIn.shopee).toBeNull(); // không seed Shopee → độc lập kênh
    // Độc lập P&L: không seed đơn/chi phí → expectedIn/cashOut = 0, không bị settlement chạm
    expect(cf.expectedIn).toBe(0);
    expect(cf.cashOut).toBe(0);
  });

  it("kỳ 0 settlement → cả 2 kênh null (Sắp có)", async () => {
    const cf = await computeCashFlow(RANGE);
    expect(cf.actualIn.tiktok).toBeNull();
    expect(cf.actualIn.shopee).toBeNull();
  });
});

describe("computeCashFlow — actualIn.shopee (Tiền đã về ví Shopee)", () => {
  it("net gộp REVENUE+ADJUSTMENT (hoàn âm tự giảm) + withdrawn; độc lập tiktok/P&L", async () => {
    await prisma.shopeeSettlement.createMany({
      data: [
        { externalId: "SP-REV1", shopId: "1942992175", txnTime: IN_RANGE, type: "REVENUE", orderCode: "O1", amount: 503_310, status: "ok", runningBalance: 0 },
        // REVENUE nhưng "Tiền ra" (case F2) — amount ÂM, gộp vào net.
        { externalId: "SP-REV2", shopId: "1942992175", txnTime: IN_RANGE, type: "REVENUE", orderCode: "O2", amount: -1_620, status: "ok", runningBalance: 0 },
        { externalId: "SP-ADJ1", shopId: "1942992175", txnTime: IN_RANGE, type: "ADJUSTMENT", orderCode: "O3", amount: -172_007, status: "ok", runningBalance: 0 },
        { externalId: "SP-WD1", shopId: "1942992175", txnTime: IN_RANGE, type: "WITHDRAWAL", orderCode: null, amount: -2_097_069, status: "ok", runningBalance: 0 },
      ],
    });

    const cf = await computeCashFlow(RANGE);
    expect(cf.actualIn.shopee).not.toBeNull();
    // net = 503.310 − 1.620 − 172.007 = 329.683 (hoàn/điều chỉnh âm tự trừ)
    expect(cf.actualIn.shopee!.net).toBe(329_683);
    expect(cf.actualIn.shopee!.withdrawn).toBe(2_097_069); // |Σ WITHDRAWAL|
    expect(cf.actualIn.shopee!.channel).toBe("shopee");
    expect(cf.actualIn.shopee!.unclassifiedCount).toBe(0); // không seed OTHER
    expect(cf.actualIn.tiktok).toBeNull(); // không seed TikTok → độc lập kênh
    // Độc lập P&L: WITHDRAWAL không chạm expectedIn/cashOut
    expect(cf.expectedIn).toBe(0);
    expect(cf.cashOut).toBe(0);
  });

  it("dòng OTHER (nhãn lạ) KHÔNG cộng vào net nhưng ĐẾM để cảnh báo (chống undercount âm thầm)", async () => {
    await prisma.shopeeSettlement.createMany({
      data: [
        { externalId: "SP-REV-X", shopId: "1942992175", txnTime: IN_RANGE, type: "REVENUE", orderCode: "OX", amount: 100_000, status: "ok", runningBalance: 0 },
        { externalId: "SP-OTHER1", shopId: "1942992175", txnTime: IN_RANGE, type: "OTHER", orderCode: null, amount: 50_000, status: "ok", runningBalance: 0 },
        { externalId: "SP-OTHER2", shopId: "1942992175", txnTime: IN_RANGE, type: "OTHER", orderCode: null, amount: 7_000, status: "ok", runningBalance: 0 },
      ],
    });

    const cf = await computeCashFlow(RANGE);
    expect(cf.actualIn.shopee).not.toBeNull();
    expect(cf.actualIn.shopee!.net).toBe(100_000); // OTHER KHÔNG cộng vào net
    expect(cf.actualIn.shopee!.unclassifiedCount).toBe(2);
    expect(cf.actualIn.shopee!.unclassifiedAmount).toBe(57_000);
  });

  it("kỳ CHỈ có OTHER (net/withdrawn=0) vẫn HIỆN card để cảnh báo, không ẩn im", async () => {
    await prisma.shopeeSettlement.create({
      data: { externalId: "SP-ONLY-OTHER", shopId: "1942992175", txnTime: IN_RANGE, type: "OTHER", orderCode: null, amount: 12_345, status: "ok", runningBalance: 0 },
    });

    const cf = await computeCashFlow(RANGE);
    expect(cf.actualIn.shopee).not.toBeNull(); // KHÔNG null dù net=0 → card hiện cảnh báo
    expect(cf.actualIn.shopee!.net).toBe(0);
    expect(cf.actualIn.shopee!.unclassifiedCount).toBe(1);
  });
});
