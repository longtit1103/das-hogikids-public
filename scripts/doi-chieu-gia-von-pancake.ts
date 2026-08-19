/**
 * Đối chiếu giá vốn: biến thể app đang `costPrice = 0` ↔ `average_imported_price` Pancake đã có
 * trong Bronze (`RawPancakeProduct`, shop KHO).
 *
 *   npx tsx scripts/doi-chieu-gia-von-pancake.ts            # CHỈ XEM — không ghi gì
 *   npx tsx scripts/doi-chieu-gia-von-pancake.ts --ghi       # ghi (hỏi xác nhận)
 *   npx tsx scripts/doi-chieu-gia-von-pancake.ts --ghi --yes # ghi không hỏi (CI/container)
 *
 * Vì sao cần: `Variant.costPrice` là APP-OWNED — ingest CHỈ prefill lúc CREATE, lượt sync sau
 * TUYỆT ĐỐI không ghi đè (giữ số chủ shop sửa tay). Nên biến thể nào lúc tạo chưa có giá vốn thì
 * sẽ ở lại 0 vĩnh viễn dù Pancake về sau đã có giá. Script này là đường NHẬP TAY HÀNG LOẠT có
 * người duyệt — không phải ingest tự động, nên không phá bất biến #5.
 *
 * An toàn khi ghi: mỗi lệnh update kèm điều kiện `costPrice: 0` TẠI THỜI ĐIỂM GHI ⇒ nếu chủ shop
 * vừa nhập tay dòng đó trong lúc script chạy thì số của chủ shop THẮNG, không bị đè.
 *
 * ⚠️ Trên máy dev, `DATABASE_URL` trỏ THẲNG DB PROD → in DB đích + hỏi xác nhận trước khi ghi.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import { ghepDeXuat, rutBienTheTuPayload, type BienTheKho } from "./lib/doi-chieu-gia-von";

const envPath = path.resolve(process.cwd(), ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

function moTaDbDich(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Thiếu DATABASE_URL — không biết đọc/ghi ở đâu.");
  const u = new URL(url);
  return `${u.host}${u.pathname} schema=${u.searchParams.get("schema") || "public"}`;
}

async function xacNhanGhi(soDong: number, tongTien: number): Promise<boolean> {
  if (process.argv.includes("--yes")) return true;
  if (!process.stdin.isTTY) {
    process.exitCode = 1;
    console.error("Không phải TTY (container/CI) — chạy lại kèm cờ --yes để xác nhận.");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const dap = await rl.question(
      `Ghi giá vốn cho ${soDong} biến thể (tổng ${tongTien.toLocaleString("vi-VN")} ₫/đơn vị)? (y/N) `,
    );
    return dap.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

function vnd(n: number): string {
  return `${n.toLocaleString("vi-VN")} ₫`;
}

async function main(): Promise<void> {
  const ghi = process.argv.includes("--ghi");
  const { prisma } = await import("@/lib/prisma");
  const { SHOP_KHO } = await import("@/lib/bronze/streams");

  console.log("DB đích:", moTaDbDich());

  try {
    // 1. Biến thể app đang thiếu giá vốn.
    const thieu = await prisma.variant.findMany({
      where: { costPrice: 0 },
      select: { id: true, pancakeId: true, sku: true, label: true },
    });

    // 2. Bản MỚI NHẤT mỗi sản phẩm trong Bronze shop KHO (cùng luật `DISTINCT ON` với transform).
    //    Đọc payload qua Prisma (JSON.parse) AN TOÀN ở đây: products dùng uuid chuỗi, không có
    //    số ≥16 chữ số — cùng căn cứ đã ghi ở `latestPayloads` (transform-raw-helpers.ts).
    const rawProducts = await prisma.$queryRawUnsafe<{ payload: unknown }[]>(
      `SELECT DISTINCT ON ("externalId") payload
       FROM "RawPancakeProduct" WHERE "shopId" = $1
       ORDER BY "externalId", "fetchedAt" DESC, "id" DESC`,
      SHOP_KHO,
    );
    const giaKho: BienTheKho[] = rawProducts.flatMap((r) => rutBienTheTuPayload(r.payload));

    const deXuat = ghepDeXuat(thieu, giaKho);

    console.log(
      `\nBiến thể app thiếu giá vốn: ${thieu.length} · biến thể kho đọc được từ Bronze: ${giaKho.length}`,
    );
    console.log(`→ Pancake CÓ giá cho: ${deXuat.length} biến thể\n`);

    if (deXuat.length === 0) {
      console.log("Không có gì để đối chiếu — hoặc Bronze chưa có giá, hoặc app đã đủ giá vốn.");
      return;
    }

    console.table(
      deXuat.map((d) => ({
        sku: d.sku,
        ten: d.ten.slice(0, 44),
        gia_de_xuat: vnd(d.giaDeXuat),
        nguon: d.nguon === "trung-binh" ? "TB Pancake" : "nhập lần cuối",
      })),
    );

    const conThieu = thieu.length - deXuat.length;
    if (conThieu > 0) {
      console.log(
        `\n${conThieu} biến thể vẫn PHẢI nhập tay ở màn Sản phẩm — Pancake cũng chưa có giá vốn cho chúng.`,
      );
    }

    if (!ghi) {
      console.log("\n(chế độ XEM — chưa ghi gì. Thêm cờ `--ghi` để áp dụng.)");
      return;
    }

    const tong = deXuat.reduce((s, d) => s + d.giaDeXuat, 0);
    if (!(await xacNhanGhi(deXuat.length, tong))) {
      console.log("Đã huỷ — không ghi gì.");
      return;
    }

    // Ghi TỪNG dòng với guard `costPrice: 0` — chủ shop vừa nhập tay dòng nào thì dòng đó
    // không khớp `where` nữa ⇒ số của chủ shop THẮNG, script không đè.
    let daGhi = 0;
    for (const d of deXuat) {
      const kq = await prisma.variant.updateMany({
        where: { id: d.variantId, costPrice: 0 },
        data: { costPrice: d.giaDeXuat },
      });
      daGhi += kq.count;
    }

    console.log(
      `\nXong: ghi ${daGhi} biến thể` +
        (daGhi < deXuat.length
          ? ` · ${deXuat.length - daGhi} dòng bỏ qua vì costPrice đã khác 0 (chủ shop vừa nhập tay — số của chủ shop THẮNG).`
          : "."),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
