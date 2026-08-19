import { PrismaClient } from "@prisma/client";
import { expect, request as pwRequest, type APIResponse } from "@playwright/test";

import { INGEST_SECRET_TEST } from "./test-constants";
import { e2eDatabaseUrlFromEnv } from "./test-database-url";

/**
 * Helper e2e cho ingest Bronze (`POST /api/ingest/raw`) — thay hẳn endpoint cũ `/api/ingest/pancake`.
 *
 * Body: `{ stream, shopId, payload }` với `payload` là CHUỖI `JSON.stringify({ data: [...] })`
 * (n8n đẩy TEXT THÔ Pancake trả về — JS không parse, int64 an toàn).
 *
 * 2 điều bắt buộc khi seed qua luồng này:
 *  1. PRODUCTS đi TRƯỚC ORDERS — item đơn tra `Variant` theo SKU để có giá vốn.
 *  2. PRODUCTS phải land vào shop KHO (transform chỉ đọc products của shop kho — nguồn giá vốn).
 */

export const SHOP_KHO = "714995134";
export const SHOP_SHOPEE = "1942992175";
export const SHOP_TIKTOK = "100975192";

/**
 * PrismaClient của worker e2e — CHỈ khi DATABASE_URL đúng bằng URL DB test của e2e.
 * (`global-setup` ép DATABASE_URL trước khi runner fork worker.) DB dev nối chung DB THẬT của shop,
 * nên tuyệt đối không để một `deleteMany()` nào chạy nhầm chỗ.
 *
 * Dùng bản THÔ `e2eDatabaseUrlFromEnv()`: ở worker chỉ cần biết URL nào ĐƯỢC PHÉP đụng để so với
 * `DATABASE_URL` runner đã ép; guard đầy đủ (đuôi `_test`, khác DB thật) đã chạy ở runner rồi.
 */
export function testPrisma(): PrismaClient {
  const url = process.env.DATABASE_URL;
  const mongDoi = e2eDatabaseUrlFromEnv();
  if (!url || !mongDoi || url !== mongDoi) {
    throw new Error("DATABASE_URL không trỏ DB test của e2e — từ chối đụng DB (DB dev = DB thật).");
  }
  return new PrismaClient();
}

/**
 * Dọn Bronze orders + products TRƯỚC khi spec seed.
 *
 * Land dedupe theo (shopId, externalId, md5 payload): raw còn sót từ lần chạy trước ⇒ land 0 dòng ⇒
 * transform (chỉ chạy trên entity vừa land) không dựng lại Silver ⇒ spec thấy bảng rỗng. Xoá raw để
 * mỗi lần chạy đều land + transform thật.
 */
export async function resetRawPancake(): Promise<void> {
  const prisma = testPrisma();
  try {
    await prisma.rawPancakeOrder.deleteMany();
    await prisma.rawPancakeProduct.deleteMany();
  } finally {
    await prisma.$disconnect();
  }
}

/** Kết quả đã ĐỌC XONG body — request context bị dispose ngay sau lời gọi, không đọc lại được. */
export type RawResponse = {
  status: number;
  ok: boolean;
  text: string;
  /** `{ ok, stats }` hoặc `{ ok:false, error }`; `stats` là số của TRANG NÀY. */
  json: { ok?: boolean; error?: string; stats?: Record<string, number> };
};

/** POST 1 trang raw. `auth: false` để test 401. */
export async function postRaw(
  stream: string,
  shopId: string,
  records: unknown[],
  opts: { auth?: boolean } = {}
): Promise<RawResponse> {
  const ctx = await pwRequest.newContext({ baseURL: "http://localhost:3000" });
  try {
    const res: APIResponse = await ctx.post("/api/ingest/raw", {
      headers: opts.auth === false ? {} : { Authorization: `Bearer ${INGEST_SECRET_TEST}` },
      data: { stream, shopId, payload: JSON.stringify({ data: records }) },
    });
    const text = await res.text();
    let json: RawResponse["json"] = {};
    try {
      json = JSON.parse(text) as RawResponse["json"];
    } catch {
      // không phải JSON (vd 500 HTML) → giữ `text` để báo lỗi cho người đọc
    }
    return { status: res.status(), ok: res.ok(), text, json };
  } finally {
    await ctx.dispose();
  }
}

export type IngestInput = {
  products?: unknown[];
  orders?: unknown[];
  /** Shop của ĐƠN (shop bán). Mặc định Shopee. Products luôn đi shop KHO. */
  orderShopId?: string;
};

/** Seed qua đúng luồng ingest thật: products (shop kho) → orders (shop bán). Fail-fast nếu route không 2xx. */
export async function ingestPancake({ products = [], orders = [], orderShopId = SHOP_SHOPEE }: IngestInput): Promise<void> {
  if (products.length) {
    const res = await postRaw("products", SHOP_KHO, products);
    expect(res.ok, `ingest products: ${res.text}`).toBe(true);
  }
  if (orders.length) {
    const res = await postRaw("orders", orderShopId, orders);
    expect(res.ok, `ingest orders: ${res.text}`).toBe(true);
  }
}
