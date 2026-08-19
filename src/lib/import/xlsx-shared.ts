import * as XLSX from "xlsx";

/**
 * Helper dùng CHUNG cho các parser import file tay (.xlsx/.csv): đọc workbook →
 * mảng-các-mảng, parse số tiền VND → Int, chuẩn hoá tên cột (bỏ dấu).
 *
 * Tách ra đây để 3 parser (ads-csv, cost-excel, shopee-wallet) KHÔNG mỗi nơi một
 * bản đọc-sheet / parser-tiền riêng — trước đây `readSheetRows` + parser tiền nằm
 * private trong từng file, dễ trôi lệch nhau (bug tiền âm thầm khi 1 bản sửa).
 */

/**
 * Giải mã bytes → chuỗi. Nhận diện BOM UTF-16 LE/BE; còn lại coi là UTF-8
 * (TextDecoder mặc định tự nuốt BOM UTF-8). File Ads Manager hay xuất UTF-16.
 */
function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * Đọc workbook (sheet đầu) thành mảng-các-mảng (mỗi phần tử = 1 dòng, dạng thô).
 *  - .xlsx (chữ ký ZIP "PK") → đọc nhị phân, `cellDates` để ô ngày ra Date thật.
 *  - .csv/text → tự giải mã (BOM/UTF-16) rồi `raw:true` để GIỮ NGUYÊN chuỗi gốc
 *    ("2026-07-01" thay vì bị xlsx suy ra serial lệch múi giờ).
 *
 * KHÔNG tự dò dòng header — trả AOA thô, caller tự tìm header (file ví Shopee có
 * ~17 dòng preamble + block "Tóm tắt" TRƯỚC dòng header thật).
 */
export function readSheetRows(buf: ArrayBuffer): (string | number | Date)[][] {
  const bytes = new Uint8Array(buf);
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b; // "PK" → .xlsx
  const wb = isZip
    ? XLSX.read(buf, { type: "array", cellDates: true })
    : XLSX.read(decodeText(bytes), { type: "string", raw: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json<(string | number | Date)[]>(sheet, { header: 1, defval: "" });
}

/**
 * Ô số tiền VND → Int (đồng) hoặc null. GIỮ dấu âm.
 *  - number → Math.round (an toàn ô số thực; xlsx đôi khi trả number).
 *  - chuỗi → bỏ ₫/đ + dấu ngăn nghìn (`.` `,`) + khoảng trắng rồi parseInt.
 *
 * VND không có phần lẻ trong các file import (ads/giá vốn/ví Shopee) nên `.` `,`
 * đều là dấu ngăn nghìn. Không parse được số nguyên → null.
 */
export function parseVnInt(val: unknown): number | null {
  if (val === null || val === undefined || val === "") return null;
  if (typeof val === "number") return Number.isFinite(val) ? Math.round(val) : null;
  const s = String(val)
    .replace(/₫/g, "")
    .replace(/đ/gi, "")
    .replace(/[.,\s]/g, "")
    .trim();
  if (s === "" || !/^-?\d+$/.test(s)) return null;
  return Number.parseInt(s, 10);
}

/** Bỏ dấu tiếng Việt + hạ chữ thường + gộp khoảng trắng — so tên cột không phân biệt dấu/hoa-thường. */
export function normHeader(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
