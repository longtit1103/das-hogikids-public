import { beforeAll, beforeEach, describe, expect, it } from "vitest";

// INGEST_SECRET phải set TRƯỚC khi import route (requireIngestSecret đọc process.env lúc chạy).
const SECRET = "test-ingest-secret";
process.env.INGEST_SECRET = SECRET;

import { POST } from "@/app/api/ingest/raw/route";
import { SHOP_SHOPEE, SHOP_TIKTOK_SHOP } from "@/lib/bronze/streams";
import { prisma } from "@/lib/prisma";

import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * SyncLog PHẢI tách theo NGUỒN.
 *
 * Trước đây route ghi kind=PANCAKE cho MỌI stream: nightly TikTok (phí/đối soát) chạy OK sẽ đẻ hàng
 * chục log PANCAKE status=OK ⇒ badge "Đồng bộ lúc…" trên /don-hang, empty-state dashboard và nút
 * "Đồng bộ ngay" đều báo XANH trong khi luồng DOANH THU Pancake có thể đã chết nhiều ngày — và log
 * Pancake/ads thật bị đẩy khỏi danh sách 10 dòng gần nhất.
 */

const ORDER = `{"success":true,"data":[{"id":"ORD-KIND-1","status":3,"inserted_at":"2026-07-01T10:00:00.000000",
  "order_sources_name":"Shopee","marketplace_id":"-3","total_price":100000,"total_discount":0,"fee_marketplace":0,
  "items":[{"quantity":1,"discount_each_product":0,
    "variation_info":{"display_id":"SKU-K1","name":"SP","retail_price":100000}}]}]}`;

const STATEMENTS = `{"code":0,"message":"Success","data":{"statements":[
  {"id":"7639761649183852289","statement_time":1778803200,"settlement_amount":"159902","currency":"VND"}]}}`;

const post = (stream: string, shopId: string, payload: string) =>
  POST(
    new Request("http://localhost/api/ingest/raw", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ stream, shopId, payload }),
    })
  );

beforeAll(async () => {
  await seedReference(); // kênh/danh mục cho bước transform của stream Pancake
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.syncLog.deleteMany();
  await prisma.rawPancakeOrder.deleteMany();
  await prisma.rawTiktokShopStatement.deleteMany();
  await prisma.rawTiktokBusinessReport.deleteMany();
});

describe("POST /api/ingest/raw — kind của SyncLog theo NGUỒN", () => {
  it("stream tiktok/* → SyncLog kind=TIKTOK_SHOP (KHÔNG sơn xanh trạng thái Pancake)", async () => {
    const res = await post("tiktok/statements", SHOP_TIKTOK_SHOP, STATEMENTS);
    expect(res.status).toBe(200);

    const logs = await prisma.syncLog.findMany();
    expect(logs).toHaveLength(1);
    expect(logs[0].kind).toBe("TIKTOK_SHOP");
    expect(logs[0].status).toBe("OK");

    // Chốt chặn cốt lõi: UI đọc kind=PANCAKE + status=OK để báo "đơn vẫn về".
    expect(await prisma.syncLog.count({ where: { kind: "PANCAKE" } })).toBe(0);
  });

  /**
   * BẪY: `"tiktokbusiness/report".startsWith("tiktok/")` là FALSE → luật cũ ném nó về PANCAKE.
   * Chi tiêu quảng cáo chạy OK sẽ "sơn xanh" trạng thái Pancake, che việc Pancake đã chết.
   */
  it("stream tiktokbusiness/* → kind=TIKTOK_ADS (KHÔNG rơi nhầm về PANCAKE)", async () => {
    const BAO_CAO = `{"code":0,"message":"OK","data":{"list":[
      {"dimensions":{"campaign_id":"1864314018521233","stat_time_day":"2026-05-20 00:00:00"},
       "metrics":{"campaign_name":"GMV Max","cost":81617}}]}}`;

    const res = await post("tiktokbusiness/report", "7129548444015902722", BAO_CAO);
    expect(res.status).toBe(200);

    const logs = await prisma.syncLog.findMany();
    expect(logs).toHaveLength(1);
    expect(logs[0].kind).toBe("TIKTOK_ADS");
    expect(await prisma.syncLog.count({ where: { kind: "PANCAKE" } })).toBe(0);
  });

  it("stream Pancake → SyncLog kind=PANCAKE (hành vi cũ giữ nguyên)", async () => {
    const res = await post("orders", SHOP_SHOPEE, ORDER);
    expect(res.status).toBe(200);

    const logs = await prisma.syncLog.findMany();
    expect(logs).toHaveLength(1);
    expect(logs[0].kind).toBe("PANCAKE");
  });

  it("shopId nhầm hệ (id Pancake cho stream tiktok/*) → 500 + SyncLog ERROR đúng kind, KHÔNG land", async () => {
    const res = await post("tiktok/statements", "100975192", STATEMENTS);
    expect(res.status).toBe(500);

    const logs = await prisma.syncLog.findMany();
    expect(logs[0].kind).toBe("TIKTOK_SHOP");
    expect(logs[0].status).toBe("ERROR");
    expect(await prisma.rawTiktokShopStatement.count()).toBe(0);
  });
});
