import { describe, expect, it } from "vitest";

import { ghepDeXuat, rutBienTheTuPayload } from "../scripts/lib/doi-chieu-gia-von";

/**
 * Logic thuần của script đối chiếu giá vốn (`scripts/doi-chieu-gia-von-pancake.ts`).
 * Việc này chạm `Variant.costPrice` — số APP-OWNED chủ shop sửa tay — nên luật ghép phải có test.
 */

const SP_KHO = {
  id: "P-1",
  name: "Bộ Lụa Áo",
  variations: [
    { id: "V-A", display_id: "SP000463", average_imported_price: 181149, last_imported_price: 180000 },
    { id: "V-B", display_id: "SP000464", average_imported_price: 0, last_imported_price: 95000 },
    { id: "V-C", display_id: "SP000465", average_imported_price: 0, last_imported_price: 0 },
  ],
};

const APP = [
  { id: "v1", pancakeId: "V-A", sku: "SP000463", label: "90/Đỏ" },
  { id: "v2", pancakeId: "V-B", sku: "SP000464", label: "100/Đỏ" },
  { id: "v3", pancakeId: "V-C", sku: "SP000465", label: "110/Đỏ" },
];

describe("rutBienTheTuPayload", () => {
  it("rút uuid + SKU + 2 mức giá từ payload sản phẩm kho", () => {
    const ket = rutBienTheTuPayload(SP_KHO);

    expect(ket).toHaveLength(3);
    expect(ket[0]).toMatchObject({ pancakeId: "V-A", sku: "SP000463", giaTrungBinh: 181149 });
  });

  it("payload webhook (KHÔNG có giá vốn) → mọi giá = 0, không ném lỗi", () => {
    const webhook = { id: "P-1", name: "Áo", variations: [{ id: "V-A", display_id: "SP1", retail_price: 241000 }] };

    const ket = rutBienTheTuPayload(webhook);

    expect(ket[0]).toMatchObject({ giaTrungBinh: 0, giaNhapCuoi: 0 });
  });

  it("payload rác / thiếu variations → mảng rỗng", () => {
    expect(rutBienTheTuPayload(null)).toEqual([]);
    expect(rutBienTheTuPayload("chuỗi")).toEqual([]);
    expect(rutBienTheTuPayload({ id: "P", name: "X" })).toEqual([]);
  });

  it("biến thể thiếu `id` bị bỏ (không có khoá thì không ghép được)", () => {
    const ket = rutBienTheTuPayload({ name: "X", variations: [{ display_id: "SKU" }] });
    expect(ket).toEqual([]);
  });
});

describe("ghepDeXuat", () => {
  it("ưu tiên giá trung bình, thiếu thì lấy giá nhập cuối — cùng luật prefill lúc CREATE", () => {
    const ket = ghepDeXuat(APP, rutBienTheTuPayload(SP_KHO));

    expect(ket).toHaveLength(2); // V-C không có giá nào → không đề xuất
    expect(ket[0]).toMatchObject({ sku: "SP000463", giaDeXuat: 181149, nguon: "trung-binh" });
    expect(ket[1]).toMatchObject({ sku: "SP000464", giaDeXuat: 95000, nguon: "nhap-cuoi" });
  });

  it("khớp theo pancakeId chứ KHÔNG theo SKU (Pancake cho phép SKU trùng giữa sản phẩm)", () => {
    const appSkuTrungNhungUuidKhac = [{ id: "v9", pancakeId: "V-KHAC", sku: "SP000463", label: "90/Đỏ" }];

    expect(ghepDeXuat(appSkuTrungNhungUuidKhac, rutBienTheTuPayload(SP_KHO))).toEqual([]);
  });

  it("giá cao xếp trước — sửa vài dòng đầu là bịt phần lớn sai lệch COGS", () => {
    const ket = ghepDeXuat(APP, rutBienTheTuPayload(SP_KHO));

    expect(ket.map((d) => d.giaDeXuat)).toEqual([181149, 95000]);
  });

  it("giá âm / không phải số → coi như KHÔNG có giá, không đề xuất bừa", () => {
    const ban = { name: "X", variations: [{ id: "V-A", average_imported_price: -5, last_imported_price: "rác" }] };

    expect(ghepDeXuat(APP, rutBienTheTuPayload(ban))).toEqual([]);
  });
});
