/**
 * Logic THUẦN cho việc đối chiếu giá vốn app ↔ giá vốn Pancake (Bronze products shop KHO).
 * Tách khỏi script để phần quyết định "đề xuất giá nào" có test, không lẫn phần đọc/ghi DB.
 *
 * Bối cảnh: 305/502 biến thể trong app đang `costPrice = 0` ⇒ COGS thiếu ⇒ lãi hiển thị cao ảo.
 * Pancake ĐÃ có `average_imported_price` cho một phần trong số đó (đo 2026-07-27: 27/60 biến thể
 * của 4 sản phẩm kho có giá > 0), nhưng luật ingest CẤM tự ghi đè `costPrice` (APP-OWNED — chủ shop
 * sửa tay) nên số đó không bao giờ tự chảy vào app sau lần CREATE đầu tiên.
 *
 * Script này KHÔNG phải ingest: nó là công cụ NHẬP TAY HÀNG LOẠT — chủ shop xem danh sách rồi
 * mới duyệt ghi. Vì thế không vi phạm bất biến #5.
 */

/** Một biến thể đọc từ payload products Bronze (shop KHO). */
export type BienTheKho = {
  pancakeId: string;
  sku: string | null;
  tenSanPham: string;
  /** `average_imported_price` — giá vốn trung bình Pancake tính. */
  giaTrungBinh: number;
  /** `last_imported_price` — giá nhập lần cuối; dùng khi trung bình chưa có. */
  giaNhapCuoi: number;
};

/** Biến thể trong app đang thiếu giá vốn. */
export type BienTheThieuGiaVon = {
  id: string;
  pancakeId: string;
  sku: string;
  label: string;
};

export type DeXuatGiaVon = {
  variantId: string;
  pancakeId: string;
  sku: string;
  ten: string;
  giaDeXuat: number;
  /** Nguồn số: giá trung bình Pancake hay giá nhập lần cuối. */
  nguon: "trung-binh" | "nhap-cuoi";
};

/**
 * Rút danh sách biến thể + giá vốn từ payload 1 sản phẩm Bronze.
 *
 * AN TOÀN int64: products Pancake dùng uuid CHUỖI cho `id` biến thể, không có số ≥16 chữ số
 * (đã verify khi dựng Bronze — xem ghi chú `latestPayloads` ở transform-raw-helpers.ts).
 */
export function rutBienTheTuPayload(payload: unknown): BienTheKho[] {
  if (payload === null || typeof payload !== "object") return [];
  const sp = payload as Record<string, unknown>;
  const tenSanPham = typeof sp.name === "string" ? sp.name : "(không tên)";
  const variations = Array.isArray(sp.variations) ? sp.variations : [];

  const ket: BienTheKho[] = [];
  for (const v of variations) {
    if (v === null || typeof v !== "object") continue;
    const bt = v as Record<string, unknown>;
    const pancakeId = typeof bt.id === "string" ? bt.id : null;
    if (!pancakeId) continue;
    ket.push({
      pancakeId,
      sku: bt.display_id == null ? null : String(bt.display_id),
      tenSanPham,
      giaTrungBinh: soDuong(bt.average_imported_price),
      giaNhapCuoi: soDuong(bt.last_imported_price),
    });
  }
  return ket;
}

/** Ép về số nguyên không âm; mọi thứ khác (null/chuỗi rác/âm) → 0 = "không có giá". */
function soDuong(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : 0;
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n);
}

/**
 * Ghép biến thể app thiếu giá vốn với giá bên Pancake.
 *
 * Khớp theo `pancakeId` (uuid biến thể) — KHÔNG khớp theo SKU: Pancake cho phép SKU trùng nhau
 * giữa các sản phẩm (ghi chú sẵn ở `pancake-schemas.ts`), khớp nhầm là gán giá vốn của mặt hàng
 * khác vào ⇒ COGS sai mà không ai biết.
 *
 * Ưu tiên `average_imported_price`, thiếu thì `last_imported_price` — cùng thứ tự với luật prefill
 * lúc CREATE ở `pancake-mapping.ts` (một luật, hai chỗ dùng, không được lệch nhau).
 */
export function ghepDeXuat(
  thieuGiaVon: BienTheThieuGiaVon[],
  giaKho: BienTheKho[],
): DeXuatGiaVon[] {
  const theoPancakeId = new Map(giaKho.map((g) => [g.pancakeId, g]));
  const ket: DeXuatGiaVon[] = [];

  for (const bt of thieuGiaVon) {
    const kho = theoPancakeId.get(bt.pancakeId);
    if (!kho) continue;
    const giaDeXuat = kho.giaTrungBinh || kho.giaNhapCuoi;
    if (giaDeXuat <= 0) continue;
    ket.push({
      variantId: bt.id,
      pancakeId: bt.pancakeId,
      sku: bt.sku,
      ten: `${kho.tenSanPham} · ${bt.label}`,
      giaDeXuat,
      nguon: kho.giaTrungBinh > 0 ? "trung-binh" : "nhap-cuoi",
    });
  }
  // Giá cao xếp trước: sửa vài dòng đầu là bịt được phần lớn sai lệch COGS.
  return ket.sort((a, b) => b.giaDeXuat - a.giaDeXuat);
}
