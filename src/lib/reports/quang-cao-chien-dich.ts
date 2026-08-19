import { endOfDay, format } from "date-fns";

import type { DateRange } from "@/lib/date-range";
import { prisma } from "@/lib/prisma";

/**
 * HIỆU QUẢ QUẢNG CÁO THEO CHIẾN DỊCH — Meta + TikTok Ads.
 *
 * Tiền lấy từ `Expense` (danh mục `ads`) chứ KHÔNG lấy từ kho thô: sổ chi phí là
 * nguồn tiền duy nhất của app, đã gồm VAT và đã khớp P&L. Lấy `spend` thô ở đây
 * là dựng con số thứ hai cho cùng một khoản chi — đúng lớp lỗi "đuổi theo con số
 * ở hai nơi" mà repo đã dính nhiều lần.
 *
 * Chỉ số hiển thị/click lấy từ Bronze `RawMetaAdsReport` — nơi DUY NHẤT có chúng.
 * Đo 2026-08-18: Meta có đủ impressions/clicks/reach (1353/1353 dòng); TikTok
 * Business chỉ có `campaign_name` + `cost`, không có chỉ số nào ⇒ dòng TikTok cố
 * ý để trống thay vì bịa số 0 (0 và "không có dữ liệu" là hai chuyện khác nhau).
 *
 * ⚠️ KHÔNG có ROAS cấp chiến dịch, và đó là CỐ Ý: app không có cách nào quy doanh
 * thu về từng chiến dịch. Doanh thu 100% từ Pancake (bất biến #2), còn số
 * GMV/đơn do sàn quảng cáo tự nhận công thì TUYỆT ĐỐI không được dùng. Bịa một
 * cột ROAS cấp chiến dịch ở đây là mời người đọc ra quyết định tiền trên số sai.
 * ROAS cấp KÊNH đã có sẵn và đúng ở `/kenh` (`computeChannelPnl`).
 */

export type ChienDichQuangCao = {
  campaignId: string;
  ten: string;
  /** true khi dòng này là cụm chi phí ads KHÔNG tra được chiến dịch (refId trống). */
  khongRoChienDich: boolean;
  /** Số dòng chi phí gộp vào — chỉ có nghĩa với dòng "không rõ chiến dịch". */
  soDongGop: number;
  /** "META" | "TIKTOK_ADS" — đúng giá trị `Expense.adsSource`. */
  nguon: string;
  /** Chi tiêu ĐÃ GỒM VAT, lấy thẳng từ sổ chi phí (khớp P&L). */
  chiTieu: number;
  /** null khi nguồn không cung cấp chỉ số (TikTok hiện chưa có). */
  hienThi: number | null;
  click: number | null;
  /** clicks/impressions × 100. null khi thiếu dữ liệu hoặc impressions = 0. */
  ctr: number | null;
  /** chiTieu/impressions × 1000 — tính trên tiền ĐÃ GỒM VAT. */
  cpm: number | null;
  /** chiTieu/clicks — tính trên tiền ĐÃ GỒM VAT. */
  cpc: number | null;
};

export type QuangCaoTheoChienDich = {
  chienDich: ChienDichQuangCao[];
  tongChiTieu: number;
  /** Nguồn có mặt trong kỳ — để lớp hiển thị biết có cần chú thích "chưa có chỉ số" không. */
  nguonCoChiSo: string[];
  nguonThieuChiSo: string[];
};

type HangChi = {
  campaign_id: string | null;
  ten: string;
  nguon: string;
  chi_tieu: bigint;
  so_dong: number;
};
type HangChiSo = { campaign_id: string; hien_thi: bigint; click: bigint };

/** Chia an toàn: mẫu 0 hoặc thiếu vế thì trả null, KHÔNG trả 0 (0 đọc ra là "đo được và bằng 0"). */
function chia(tu: number | null, mau: number | null, heSo = 1): number | null {
  if (tu === null || mau === null || mau === 0) return null;
  return (tu / mau) * heSo;
}

/**
 * Gom chi tiêu quảng cáo theo chiến dịch trong kỳ, kèm chỉ số nơi nào có.
 *
 * Khoá chiến dịch là mảnh CUỐI của `Expense.refId`, KHÔNG phải mảnh thứ 3:
 * `prepareAdsExpenseRow` sinh HAI khuôn — `"{NGUỒN}:{ngày}:{campaignId}"` và, riêng
 * TikTok Ads đấu giá, `"TIKTOK_ADS:auction:{ngày}:{campaignId}"` (4 mảnh). Lấy mảnh
 * thứ 3 sẽ nhặt được NGÀY ở khuôn auction ⇒ mọi chiến dịch đấu giá trong cùng một
 * ngày bị gộp thành MỘT dòng mang tên một chiến dịch bất kỳ, mà tổng vẫn đúng nên
 * không có tín hiệu nào báo sai. Đo 2026-08-18: prod chưa có dòng auction nào
 * (shop chạy GMV Max), nhưng đường sinh đã sống nên chặn trước.
 *
 * Dòng ads KHÔNG có `refId` (import file / nhập tay — `ads-import.ts` ghi
 * `refId: null`) không tra được chiến dịch. Chúng gom vào MỘT dòng mang nhãn cố định
 * "(không rõ chiến dịch)" kèm số dòng gộp — KHÔNG mượn tên của một chiến dịch cụ thể
 * (mượn tên là nói với chủ shop rằng chiến dịch đó tiêu cả cụm tiền). Vẫn phải hiện,
 * vì tiền biến mất khỏi bảng là lỗi nặng hơn một dòng xấu xí.
 */
export async function quangCaoTheoChienDich(range: DateRange): Promise<QuangCaoTheoChienDich> {
  const to = endOfDay(range.to);

  const [chiRows, chiSoRows] = await Promise.all([
    prisma.$queryRaw<HangChi[]>`
      SELECT
        -- Mảnh CUỐI, không phải mảnh thứ 3 — khuôn auction có 4 mảnh (xem docblock).
        NULLIF(substring("refId" from '([^:]+)$'), '') AS campaign_id,
        -- Tên chiến dịch: Expense.description giữ nguyên tên sàn đặt. Một campaignId
        -- về lý thuyết có thể đổi tên giữa kỳ ⇒ lấy tên của dòng MỚI NHẤT. Thêm
        -- description làm chốt phụ để hai dòng cùng ngày không cho kết quả tuỳ ý.
        (array_agg(description ORDER BY date DESC, description))[1] AS ten,
        COALESCE("adsSource", 'KHAC')           AS nguon,
        SUM(amount)::bigint                     AS chi_tieu,
        COUNT(*)::int                           AS so_dong
      FROM "Expense"
      WHERE "categoryId" = 'ads'
        AND date >= ${range.from}
        AND date <= ${to}
      GROUP BY 1, 3
    `,
    prisma.$queryRaw<HangChiSo[]>`
      WITH moi_nhat AS (
        -- Bronze khử trùng theo NỘI DUNG nên Meta gửi lại cùng (ngày, chiến dịch)
        -- với số đã chốt lại là THÊM DÒNG chứ không đè. Cộng thẳng ⇒ hiển thị/click
        -- phồng lên. Giữ đúng một bản mới nhất cho mỗi khoá gốc.
        SELECT DISTINCT ON ("shopId", "externalId") payload
        FROM "RawMetaAdsReport"
        -- So bằng CHUỖI "YYYY-MM-DD" tính sẵn theo giờ VN, KHÔNG ép kiểu Date sang
        -- ::date trong SQL: phép ép đó dịch theo GUC TimeZone của session Postgres,
        -- mà prod đang là UTC (đo 2026-08-18) ⇒ mốc 01/05 00:00+07 thành 2026-04-30, kéo thêm
        -- MỘT NGÀY vào đầu kỳ ⇒ hiển thị/click phồng lên, CPM/CPC rẻ đi mà không
        -- có dấu hiệu gì. Chuỗi ISO so đúng thứ tự từ điển nên so trực tiếp là an toàn.
        WHERE payload->>'date_start' >= ${format(range.from, "yyyy-MM-dd")}
          AND payload->>'date_start' <= ${format(to, "yyyy-MM-dd")}
        -- id chốt cuối: fetchedAt là TIMESTAMP(3) và cả một lô land dùng chung
        -- clock_timestamp() nên trùng mili-giây là chuyện thường — thiếu chốt thì
        -- bản thắng là tuỳ ý. Cùng khuôn transform-raw-helpers.ts.
        ORDER BY "shopId", "externalId", "fetchedAt" DESC, "id" DESC
      )
      SELECT
        payload->>'campaign_id' AS campaign_id,
        -- Số trong payload Meta là CHUỖI; giá trị dị làm văng cả truy vấn mà hàm
        -- này chạy trong Promise.all của trang /kenh ⇒ lọc regex trước khi ép kiểu.
        SUM(CASE WHEN payload->>'impressions' ~ '^[0-9]+$' THEN (payload->>'impressions')::numeric ELSE 0 END)::bigint AS hien_thi,
        SUM(CASE WHEN payload->>'clicks'      ~ '^[0-9]+$' THEN (payload->>'clicks')::numeric      ELSE 0 END)::bigint AS click
      FROM moi_nhat
      WHERE payload->>'campaign_id' IS NOT NULL
      GROUP BY 1
    `,
  ]);

  const chiSoTheoId = new Map(chiSoRows.map((r) => [r.campaign_id, r]));

  const chienDich: ChienDichQuangCao[] = chiRows.map((r) => {
    const campaignId = r.campaign_id ?? "";
    const khongRo = campaignId === "";
    // Chỉ số CHỈ có ở Meta, nên chỉ gắn cho dòng nguồn META. Tra bằng campaignId
    // trần thì một chiến dịch TikTok trùng mã với chiến dịch Meta sẽ MƯỢN hiển
    // thị/click của Meta — hai sàn đánh mã riêng nên xác suất thấp, nhưng không có
    // gì chặn, và số mượn được thì nhìn vẫn hợp lý.
    const cs = khongRo || r.nguon !== "META" ? undefined : chiSoTheoId.get(campaignId);
    const chiTieu = Number(r.chi_tieu);
    const hienThi = cs ? Number(cs.hien_thi) : null;
    const click = cs ? Number(cs.click) : null;

    return {
      campaignId,
      // Nhãn CỐ ĐỊNH cho cụm không tra được, KHÔNG mượn tên một chiến dịch cụ thể:
      // mượn tên là nói với chủ shop rằng chiến dịch đó tiêu cả cụm tiền.
      ten: khongRo ? "(không rõ chiến dịch)" : r.ten,
      khongRoChienDich: khongRo,
      soDongGop: r.so_dong,
      nguon: r.nguon,
      chiTieu,
      hienThi,
      click,
      ctr: chia(click, hienThi, 100),
      cpm: chia(chiTieu, hienThi, 1000),
      cpc: chia(chiTieu, click),
    };
  });

  chienDich.sort((a, b) => b.chiTieu - a.chiTieu);

  // Một nguồn chỉ bị gọi là "thiếu chỉ số" khi KHÔNG dòng nào của nó có chỉ số.
  // Phân biệt với ca "dòng này không tra được" (vd chi phí nhập tay không có refId):
  // gộp hai ca lại thì chú thích chân bảng sẽ nói "Meta chưa trả chỉ số" ngay bên
  // trên mấy dòng Meta đang hiện đủ số — tự mâu thuẫn với chính cái bảng.
  // Chỉ xét dòng CÓ chi tiêu, vì lớp hiển thị ẩn dòng 0đ: chú thích mà mô tả dòng
  // đang bị ẩn thì chủ shop không có cách nào đối chiếu.
  const coChiSo = new Set<string>();
  const moiNguon = new Set<string>();
  for (const c of chienDich) {
    if (c.chiTieu <= 0) continue;
    moiNguon.add(c.nguon);
    if (c.hienThi !== null) coChiSo.add(c.nguon);
  }
  const thieuChiSo = new Set([...moiNguon].filter((n) => !coChiSo.has(n)));

  return {
    chienDich,
    tongChiTieu: chienDich.reduce((s, c) => s + c.chiTieu, 0),
    nguonCoChiSo: [...coChiSo].sort(),
    nguonThieuChiSo: [...thieuChiSo].sort(),
  };
}
