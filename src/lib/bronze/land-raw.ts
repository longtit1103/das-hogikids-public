import type { Prisma, PrismaClient } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { BRONZE_STREAMS, isBronzeStream, type BronzeStream } from "./streams";

/**
 * Client Prisma thường HOẶC client trong `$transaction`. Người gọi truyền client
 * transaction khi bước land phải nằm CÙNG transaction với một khoá tư vấn (xem
 * `khoa-land-don.ts`) — đọc-để-quyết-định rồi mới ghi thì hai bước phải bất khả phân.
 */
type ClientBronze = PrismaClient | Prisma.TransactionClient;

/**
 * Với stream danh sách shop MỞ (`shops: null` trong registry) không có whitelist để chặn shopId.
 * Ép SHAPE của shopId theo TÊN STREAM — regex là HẰNG trong code, TUYỆT ĐỐI KHÔNG lấy từ input:
 *   - `meta/report`: ad account Meta dạng `act_<số>`.
 *   - `tiktokbusiness/report`: advertiser_id (chuỗi số ≥6 chữ số).
 *   - `tiktokbusiness/invoice`: bc_id Business Center (chuỗi số ≥6 chữ số).
 * Không phân biệt được bc_id với advertiser_id (đều là chuỗi số) — nhưng chặn được id SAI KIỂU (vd
 * `act_...` của Meta lọt vào stream TikTok, hoặc chuỗi rác) TRƯỚC khi nó nằm vĩnh viễn trong Bronze
 * (append-only, không sửa được) làm mọi đối soát join theo shopId về sau lệch.
 */
const OPEN_SHOP_SHAPE: Partial<Record<BronzeStream, { re: RegExp; moTa: string }>> = {
  "meta/report": { re: /^act_\d+$/, moTa: "ad account Meta dạng 'act_<số>'" },
  "tiktokbusiness/report": { re: /^\d{6,}$/, moTa: "advertiser_id TikTok Business (chuỗi ≥6 chữ số)" },
  "tiktokbusiness/invoice": { re: /^\d{6,}$/, moTa: "bc_id Business Center (chuỗi ≥6 chữ số)" },
};

export type LandResult = {
  /** Số dòng THỰC SỰ ghi vào Bronze (đã trừ bản trùng hash). */
  landed: number;
  /** Số record bị bỏ vì thiếu `id` — route đẩy vào `warnings`, KHÔNG im lặng. */
  skippedNoId: number;
  /**
   * `externalId` của các dòng THỰC SỰ chèn ở lần gọi này (lấy bằng `RETURNING`; dòng trùng hash
   * đi nhánh `DO NOTHING` nên KHÔNG trả về). Transform dùng để chỉ dựng lại đúng entity của TRANG
   * NÀY — không quét lại toàn bảng mỗi trang (import 60 ngày sẽ thành chi phí bậc 2 → n8n timeout).
   * Entity trùng hash không transform lại là ĐÚNG **khi lượt transform trước đã chạy xong** —
   * xem `seenIds` cho ca nó KHÔNG chạy xong.
   */
  landedIds: string[];
  /**
   * MỌI `externalId` nhìn thấy trong trang, kể cả record trùng hash nên không land lại.
   *
   * Đây là đường tự chữa: tiến trình chết giữa "Bronze đã commit" và "Silver ghi xong"
   * thì lượt n8n gửi lại đúng trang đó có `landedIds` RỖNG (nội dung y hệt) ⇒ nếu chỉ nhìn
   * `landedIds` thì transform không có gì để làm, HTTP 200 sạch trơn, còn đơn thì kẹt vĩnh viễn.
   * Người gọi dùng `seenIds` để hỏi lại Bronze xem trong số đó có dòng nào CHƯA đóng dấu kết cục
   * không, và dựng lại đúng những dòng đó.
   */
  seenIds: string[];
};

/**
 * Land raw NGUYÊN BẢN vào Bronze.
 *
 * BẤT BIẾN: JS TUYỆT ĐỐI KHÔNG `JSON.parse` payload. Pancake trả int64 vượt
 * Number.MAX_SAFE_INTEGER (vd inventory_histories.id = 461168615117802872) →
 * JS parse làm tròn thành …900, hỏng khoá. Nên:
 *   - `responseText` đi thẳng vào Postgres dưới dạng TEXT,
 *   - Postgres cast `::jsonb` (jsonb lưu số dạng numeric → không mất chính xác),
 *   - `jsonb_array_elements` bung mảng, `elem->>'id'` rút khoá dạng TEXT,
 *   - `md5(elem::text)` băm trên jsonb ĐÃ CHUẨN HOÁ (key sort) → hash ổn định.
 *
 * Dedupe bằng ON CONFLICT trên @@unique([shopId, externalId, payloadHash]):
 * nội dung không đổi → không ghi; nội dung đổi → ghi bản mới (giữ lịch sử).
 * Append-only: không UPDATE, không DELETE.
 *
 * Mảng record nằm ở đâu trong envelope là TUỲ NHÀ CUNG CẤP (`arrayPath` trong registry):
 * Pancake `{success, data:[…]}`; TikTok Shop `{code, message, data:{statements:[…]}}`. Đường dẫn
 * đi vào SQL qua toán tử `#>` với THAM SỐ text[] (không nội suy chuỗi), và giá trị luôn lấy từ
 * registry hằng số — client KHÔNG được chọn đường dẫn.
 *
 * GUARD trước INSERT: khi envelope KHÔNG có mảng ở đúng đường dẫn (vd Pancake trả lỗi
 * `{"success":false,"message":"..."}` do hết hạn key / rate-limit, hay TikTok trả `code != 0`),
 * Postgres coi `(…) #> path` là NULL → `jsonb_array_elements(NULL)` cho 0 dòng và KHÔNG throw
 * ⇒ landRaw sẽ trả {landed:0} = THÀNH CÔNG GIẢ, cả một trang dữ liệu biến mất
 * không một tiếng động. Nên phải kiểm `jsonb_typeof` và throw, nêu rõ đường dẫn nào không phải mảng.
 */
export async function landRaw(
  stream: BronzeStream,
  shopId: string,
  responseText: string,
  syncLogId?: string,
  db: ClientBronze = prisma
): Promise<LandResult> {
  if (!isBronzeStream(stream)) throw new Error(`Stream không hợp lệ: ${stream}`);
  // `table` + `arrayPath` + `idExpr` là hằng số trong code (registry), KHÔNG lấy từ input.
  const { table, arrayPath, shops, idExpr } = BRONZE_STREAMS[stream];

  // shopId PHẢI thuộc `shops` của chính stream đó. Có HAI hệ đánh số shop (Pancake vs TikTok Shop
  // Open API) và tên gọi trùng nhau ("TikTok") → điền nhầm CONFIG.shopId trong n8n là chuyện dễ xảy
  // ra. Bronze là append-only: một lần backfill nhầm shopId sẽ nằm vĩnh viễn trên DB prod, không
  // báo lỗi, SyncLog vẫn OK, mọi đối soát join theo shopId sau này lệch. Chặn NGAY tại cửa.
  //
  // `shops: null` = stream có danh sách MỞ (advertiser/bc do chủ shop tự tạo) → không whitelist được;
  // KHÔNG để "không rỗng" là guard duy nhất mà ép SHAPE theo tên stream (xem OPEN_SHOP_SHAPE).
  if (shops !== null) {
    if (!shops.includes(shopId)) {
      throw new Error(
        `shopId "${shopId}" không hợp lệ cho stream "${stream}" (chỉ nhận: ${shops.join(", ")}) — ` +
          `kiểm tra CONFIG.shopId trong n8n: id shop Pancake KHÁC id shop TikTok Shop Open API.`
      );
    }
  } else {
    if (!shopId.trim()) {
      throw new Error(`shopId rỗng cho stream "${stream}" — cần advertiser_id/bc_id để biết chi tiêu của tài khoản nào.`);
    }
    const shape = OPEN_SHOP_SHAPE[stream];
    if (shape && !shape.re.test(shopId)) {
      throw new Error(
        `shopId "${shopId}" sai định dạng cho stream "${stream}" — cần ${shape.moTa}. ` +
          `Bronze append-only: id sai kiểu (vd nhầm act_... của Meta với id số TikTok) land là nằm vĩnh viễn.`
      );
    }
  }

  // Khoá của record. Mặc định `elem->>'id'`; stream nào API không trả `id` thì tự khai (báo cáo ads).
  const khoa = idExpr ?? `elem->>'id'`;
  const path = [...arrayPath];
  const shownPath = arrayPath.join(".");

  // KHÔNG IM LẶNG. MỘT query (parse payload 1 LẦN nhờ CTE MATERIALIZED, thay vì cast ::jsonb 3 lần)
  // làm CẢ HAI việc TRƯỚC insert:
  //   - `kind`: envelope có mảng ở đúng đường dẫn không? Thiếu → kêu to, không land trang rỗng giả.
  //   - `total`/`withId`: đếm record và record rút được khoá, để bắt lỗi "mảng có dữ liệu mà rút
  //     được 0 khoá" (nhà cung cấp đổi tên field khoá) — throw TRƯỚC insert, không trả landed:0 êm ru.
  // CASE ... '[]' để khi KHÔNG phải mảng thì jsonb_array_elements không ném lỗi Postgres thô; JS kiểm
  // `kind` ngay sau đó rồi mới quyết định (giữ đúng thông báo lỗi guard cũ).
  const [meta] = await db.$queryRawUnsafe<
    { kind: string | null; total: bigint; withId: bigint; seenIds: string[] | null }[]
  >(
    `
    WITH src AS MATERIALIZED (SELECT ($1::jsonb) #> $2::text[] AS arr),
    elems AS (
      SELECT elem
      FROM src, jsonb_array_elements(
        CASE WHEN jsonb_typeof(src.arr) = 'array' THEN src.arr ELSE '[]'::jsonb END
      ) AS elem
    )
    SELECT
      (SELECT jsonb_typeof(arr) FROM src) AS kind,
      (SELECT count(*) FROM elems) AS total,
      (SELECT count(${khoa}) FROM elems) AS "withId",
      -- MỌI khoá nhìn thấy trong trang, kể cả record KHÔNG land vì trùng payloadHash. Đây là thứ
      -- làm lượt gửi lại tự chữa được sau một cú chết giữa chừng: landedIds khi đó RỖNG (nội dung
      -- y hệt nên không land lại), nên nếu chỉ có nó thì transform không có gì để làm và trang đó
      -- im lặng trả 200 trong khi đơn vẫn kẹt ở Bronze. Đọc lại CHÍNH CTE elems đã bung sẵn ở
      -- trên — payload chỉ cast ::jsonb một lần, đo thật trên prod: +0,2 ms cho trang 100 đơn.
      (SELECT array_agg(DISTINCT ${khoa}) FROM elems WHERE ${khoa} IS NOT NULL) AS "seenIds"
    `,
    responseText,
    path
  );

  if (meta.kind !== "array") {
    throw new Error(
      `Envelope stream "${stream}" không có mảng tại '${shownPath}' (jsonb_typeof=${meta.kind ?? "null"}) — ` +
        `nhiều khả năng API trả lỗi (hết hạn key / token / rate-limit). Không land trang này.`
    );
  }

  const total = Number(meta.total);
  const withId = Number(meta.withId);

  // Mảng CÓ record nhưng rút được 0 khoá = hợp đồng API đã trôi (nhà cung cấp đổi tên field khoá:
  // campaign_id / date_start / transaction_id…). Guard `jsonb_typeof` KHÔNG bắt (mảng vẫn là mảng) và
  // WHERE ... IS NOT NULL bên dưới sẽ loại HẾT ⇒ landed:0, HTTP 200, SyncLog OK = mất cả trang trong
  // im lặng. Phải THROW, không land trang này.
  if (total > 0 && withId === 0) {
    throw new Error(
      `Stream "${stream}": mảng có ${total} record nhưng rút được 0 khoá (idExpr: ${khoa}) — ` +
        `hợp đồng API đã trôi (nhiều khả năng nhà cung cấp đổi tên field khoá). Không land trang này.`
    );
  }

  const inserted = await db.$queryRawUnsafe<{ externalId: string }[]>(
    `
    INSERT INTO "${table}" ("id", "shopId", "externalId", "payloadHash", "payload", "fetchedAt", "syncLogId")
    -- clock_timestamp() chứ KHÔNG phải now(): now() trả mốc MỞ transaction. Từ khi bước land nằm
    -- trong transaction có khoá tư vấn (khoa-land-don.ts), lượt phải XẾP HÀNG chờ khoá vẫn mang mốc
    -- BEGIN của nó — tức mốc TRƯỚC lượt đang giữ khoá — nên nó land SAU mà fetchedAt lại CŨ HƠN.
    -- Transform chọn bản fetchedAt mới nhất ⇒ khoá tuần tự hoá xong vẫn chọn nhầm bản cũ, đúng
    -- thứ mà khoá sinh ra để chặn. clock_timestamp() đọc đồng hồ NGAY LÚC INSERT nên phản ánh đúng
    -- thứ tự land mà khoá vừa thiết lập.
    SELECT gen_random_uuid()::text, $2, ${khoa}, md5(elem::text), elem, clock_timestamp(), $3
    FROM jsonb_array_elements(($1::jsonb) #> $4::text[]) AS elem
    WHERE ${khoa} IS NOT NULL   -- không có khoá thì không dedupe được (cần externalId)
    ON CONFLICT ("shopId", "externalId", "payloadHash") DO NOTHING
    RETURNING "externalId"
    `,
    responseText,
    shopId,
    syncLogId ?? null,
    path
  );
  const landedIds = [...new Set(inserted.map((r) => r.externalId))];

  // Record thiếu khoá (nhưng KHÔNG phải cả trang — trường hợp đó đã throw ở trên) bị mệnh đề WHERE
  // bỏ qua: báo qua `skippedNoId` để route đẩy vào warnings, không nuốt lặng. Số đã đếm ở query gộp.
  const skippedNoId = total - withId;

  return { landed: inserted.length, skippedNoId, landedIds, seenIds: meta.seenIds ?? [] };
}
