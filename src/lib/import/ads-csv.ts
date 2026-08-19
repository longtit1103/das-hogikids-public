import { normHeader, parseVnInt, readSheetRows } from "./xlsx-shared";

/**
 * Parser cho file CHI TIÊU ads xuất từ Meta Ads Manager / TikTok Ads.
 * Nhận .csv (UTF-8/UTF-16, có/không BOM) và .xlsx. KHÔNG dedupe, KHÔNG chạm DB
 * — chỉ chuẩn hoá từng dòng; dedupe + xung đột API nằm ở `ads-import.ts`.
 *
 * Ngày trả về được NEO `T00:00:00+07:00` (Asia/Ho_Chi_Minh) để 1 dòng file =
 * đúng 1 ngày VN, so khớp được với dòng ADS_API do ingest ghi (cùng cách neo).
 */

export type AdsPreset = "META" | "TIKTOK"; // adsSource tương ứng: "META" | "TIKTOK_ADS"
export type ParsedAdsRow = { date: Date; campaignName: string; amount: number };

/** Alias cột theo nguồn — file Ads Manager đổi tên cột theo thời gian nên để dạng danh sách. */
const COLUMN_ALIASES: Record<AdsPreset, { date: string[]; name: string[]; amount: string[] }> = {
  META: {
    date: ["Ngày", "Day", "Reporting starts"],
    name: ["Tên chiến dịch", "Campaign name"],
    amount: ["Số tiền đã chi tiêu (VND)", "Amount spent (VND)"],
  },
  TIKTOK: {
    date: ["Date"],
    name: ["Campaign name"],
    amount: ["Cost"],
  },
};

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Ngày (y, m, d) có THẬT trên lịch không.
 *
 * Bắt buộc phải kiểm TAY: `new Date("2026-02-31T00:00:00+07:00")` KHÔNG trả Invalid Date mà tự
 * quy đổi thành 03/03/2026 (đo bằng node 29/07). Nghĩa là một ô ngày gõ sai trong file sẽ lặng lẽ
 * ghi chi tiêu quảng cáo sang một ngày KHÁC — sai kỳ, sai cả tháng, mà không có một dòng lỗi nào.
 * Thà báo dòng lỗi cho chủ shop sửa file còn hơn tự đoán hộ.
 */
function laNgayCoThat(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  // Ngày 0 của tháng kế tiếp = ngày cuối cùng của tháng này (JS tự tính năm nhuận).
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Tìm chỉ số cột đầu tiên khớp một trong các alias (đã chuẩn hoá). -1 nếu không có. */
function findColumn(header: (string | number | Date)[], aliases: string[]): number {
  const normalized = header.map((h) => normHeader(String(h)));
  const wanted = aliases.map(normHeader);
  for (let i = 0; i < normalized.length; i++) {
    if (wanted.includes(normalized[i])) return i;
  }
  return -1;
}

/** Chuẩn hoá ô ngày → "yyyy-MM-dd" (VN) hoặc null. Nhận Date (xlsx), serial số, hoặc chuỗi. */
function parseDateCell(value: unknown): string | null {
  if (value == null || value === "") return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
  }

  if (typeof value === "number") {
    // Serial Excel (epoch 1899-12-30) → ngày UTC (tránh lệ thuộc TZ máy chạy).
    const ms = Math.round((value - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return null;
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  }

  const s = String(value).trim();
  // ISO yyyy-mm-dd (Meta/TikTok xuất mặc định) — có thể kèm phần giờ, chỉ lấy ngày.
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return laNgayCoThat(y, mo, d) ? `${m[1]}-${m[2]}-${m[3]}` : null;
  }
  // dd/mm/yyyy (định dạng VN).
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return laNgayCoThat(y, mo, d) ? `${y}-${pad2(mo)}-${pad2(d)}` : null;
  }
  return null;
}

/**
 * Parse file ads → dòng chuẩn hoá + danh sách lỗi (KHÔNG dedupe).
 * `line` = số dòng trong file (header = 1, dòng dữ liệu đầu = 2).
 * Dòng thiếu ngày/số tiền hoặc không parse được → đẩy vào `errors`, không chặn file.
 */
export function parseAdsFile(
  buf: ArrayBuffer,
  preset: AdsPreset
): { rows: ParsedAdsRow[]; errors: { line: number; reason: string }[] } {
  const rows: ParsedAdsRow[] = [];
  const errors: { line: number; reason: string }[] = [];

  const aoa = readSheetRows(buf);
  if (aoa.length === 0) {
    return { rows, errors: [{ line: 1, reason: "File rỗng hoặc không đọc được" }] };
  }

  const header = aoa[0];
  const aliases = COLUMN_ALIASES[preset];
  const dateCol = findColumn(header, aliases.date);
  const amountCol = findColumn(header, aliases.amount);
  const nameCol = findColumn(header, aliases.name);

  if (dateCol === -1 || amountCol === -1) {
    return {
      rows,
      errors: [{ line: 1, reason: "Không nhận ra cột ngày hoặc cột số tiền — cần file xuất từ Ads Manager" }],
    };
  }

  for (let i = 1; i < aoa.length; i++) {
    const line = i + 1; // dòng 1 = header
    const raw = aoa[i];
    // Bỏ qua (không báo lỗi) dòng hoàn toàn trống — hay gặp ở cuối file.
    const isBlank = raw.every((c) => c === "" || c == null);
    if (isBlank) continue;

    const dateStr = parseDateCell(raw[dateCol]);
    if (!dateStr) {
      errors.push({ line, reason: "Thiếu hoặc sai định dạng ngày" });
      continue;
    }
    const amount = parseVnInt(raw[amountCol]);
    if (amount === null) {
      errors.push({ line, reason: "Thiếu hoặc sai số tiền" });
      continue;
    }
    const campaignName = nameCol === -1 ? "" : String(raw[nameCol] ?? "").trim();
    rows.push({ date: new Date(`${dateStr}T00:00:00+07:00`), campaignName, amount });
  }

  return { rows, errors };
}
