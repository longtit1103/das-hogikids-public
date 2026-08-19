/** 3 shop Pancake (CLAUDE.md): Kho Tổng = master tồn/giá vốn; Shopee + TikTok = shop bán. */
export const SHOP_KHO = "714995134";
export const SHOP_SHOPEE = "1942992175";
export const SHOP_TIKTOK = "100975192";
const ALL = [SHOP_KHO, SHOP_SHOPEE, SHOP_TIKTOK] as const;
const MARKETPLACES = [SHOP_SHOPEE, SHOP_TIKTOK] as const;

/**
 * Shop id của TikTok Shop Open API — KHÁC HẲN `SHOP_TIKTOK` (id shop TikTok bên trong Pancake).
 * Hai hệ đánh số độc lập; trộn nhầm sẽ làm dòng Bronze TikTok đội lốt dòng Pancake.
 *
 * BẤT BIẾN #2: dữ liệu TikTok Shop CHỈ dùng cho phí / đối soát tiền thực nhận / hoa hồng aff —
 * TUYỆT ĐỐI KHÔNG lấy làm doanh thu (doanh thu chỉ từ Pancake, nếu không sẽ đếm 2 lần).
 */
export const SHOP_TIKTOK_SHOP = "7494544063361551019";
const TIKTOK_SHOP = [SHOP_TIKTOK_SHOP] as const;

export type BronzeStream =
  | "orders" | "products" | "products/variations" | "purchases"
  | "inventory_histories" | "transactions" | "marketplace/reverse_order" | "customers"
  | "tiktok/statements" | "tiktok/statement_transactions" | "tiktok/payments" | "tiktok/orders"
  | "tiktokbusiness/report" | "tiktokbusiness/invoice"
  | "meta/report"
  | "shopee/wallet";

export type BronzeStreamDef = {
  table: string;
  /**
   * Danh sách shop/tài khoản hợp lệ cho stream. `null` = KHÔNG chốt danh sách được (xem
   * `tiktokbusiness/report`: advertiser do chủ shop tự tạo, hôm nay 7 cái, mai có thể thêm) —
   * lúc đó chỉ kiểm shopId không rỗng.
   */
  shops: readonly string[] | null;
  /**
   * Đường dẫn tới MẢNG record trong envelope của API. Mỗi nhà cung cấp lồng một kiểu:
   * Pancake `{success, data:[...]}` → ["data"]; TikTok `{code, message, data:{statements:[...]}}`
   * → ["data","statements"]. Hardcode envelope của một nhà cung cấp vào landRaw sẽ khiến nhà kia
   * land 0 dòng hoặc land nhầm object.
   */
  arrayPath: readonly string[];
  /**
   * Biểu thức SQL rút KHOÁ của một record (chạy trên `elem` jsonb). Mặc định `elem->>'id'`.
   * HẰNG SỐ TRONG CODE — không bao giờ lấy từ input (nội suy thẳng vào SQL).
   *
   * Cần khai riêng khi API KHÔNG trả `id`: báo cáo quảng cáo TikTok là
   * `{dimensions:{campaign_id, stat_time_day}, metrics:{...}}` — khoá tự nhiên là
   * (chiến dịch, ngày). Không có khoá thì không dedupe được, kéo lại là nhân bản dòng.
   */
  idExpr?: string;
};

/**
 * `table` và `arrayPath` là hằng số trong code (KHÔNG bao giờ lấy từ input) → an toàn khi dùng
 * ở land-raw.ts. `shops` = shop THẬT SỰ có dữ liệu (Task 0 discovery).
 */
export const BRONZE_STREAMS: Record<BronzeStream, BronzeStreamDef> = {
  "orders": { table: "RawPancakeOrder", shops: ALL, arrayPath: ["data"] },
  "products": { table: "RawPancakeProduct", shops: ALL, arrayPath: ["data"] },
  "products/variations": { table: "RawPancakeVariation", shops: ALL, arrayPath: ["data"] },
  "purchases": { table: "RawPancakePurchase", shops: [SHOP_KHO], arrayPath: ["data"] },
  "inventory_histories": { table: "RawPancakeInventoryHistory", shops: ALL, arrayPath: ["data"] },
  "transactions": { table: "RawPancakeTransaction", shops: MARKETPLACES, arrayPath: ["data"] },
  "marketplace/reverse_order": { table: "RawPancakeReverseOrder", shops: MARKETPLACES, arrayPath: ["data"] },
  "customers": { table: "RawPancakeCustomer", shops: ALL, arrayPath: ["data"] },

  // TikTok Shop Open API — envelope {code, message, request_id, data:{<mảng>, next_page_token}}.
  "tiktok/statements": {
    table: "RawTiktokShopStatement", shops: TIKTOK_SHOP, arrayPath: ["data", "statements"],
  },
  /**
   * BẢN 202501, KHÔNG phải 202309 — chỉ bản này trả `type` (`ORDER` | `GMV_PAYMENT_FOR_TIKTOK_ADS` | …)
   * và mảng nằm ở `data.transactions` (bản 202309 dùng `data.statement_transactions`, KHÔNG có `type`).
   *
   * `type` là cách DUY NHẤT phân biệt tiền quảng cáo TikTok trừ vào số dư shop (GMV Pay) với tiền
   * đơn hàng: TikTok Ads gom chi tiêu tới NGƯỠNG mới trừ, mà ngưỡng THAY ĐỔI theo thời gian
   * (đo 15/05–16/06: đúng 143.000đ/lần, nhưng con số này không bền) ⇒ TUYỆT ĐỐI không nhận diện
   * bằng số tiền.
   */
  "tiktok/statement_transactions": {
    table: "RawTiktokShopTransaction", shops: TIKTOK_SHOP, arrayPath: ["data", "transactions"],
  },
  "tiktok/payments": {
    table: "RawTiktokShopPayment", shops: TIKTOK_SHOP, arrayPath: ["data", "payments"],
  },
  /**
   * CỐ Ý KHÔNG KÉO (RawTiktokShopOrder = 0 dòng là ĐÚNG, không phải chết thầm): `tiktokshop-nightly`
   * chỉ kéo statements + statement_transactions + payments (PHÍ/đối soát). Đơn TikTok Shop TUYỆT ĐỐI
   * KHÔNG lấy làm doanh thu (bất biến #2 — doanh thu chỉ từ Pancake). Định nghĩa giữ ở đây để nếu mai
   * cần đối soát cấp đơn thì có sẵn shape; hôm nay không workflow nào populate.
   */
  "tiktok/orders": {
    table: "RawTiktokShopOrder", shops: TIKTOK_SHOP, arrayPath: ["data", "orders"],
  },

  /**
   * TikTok BUSINESS (business-api.tiktok.com) — CHI TIÊU quảng cáo. API KHÁC HẲN TikTok Shop:
   * khác portal, khác token, khác envelope `{code, message, data:{list:[...], page_info}}`.
   *
   * BẤT BIẾN #2: CHỈ lấy chi tiêu. TUYỆT ĐỐI không lấy GMV/doanh thu từ đây (doanh thu chỉ từ Pancake).
   *
   * `shopId` của stream này = **advertiser_id** (không phải shop). Không chốt danh sách được:
   * chủ shop có 7 tài khoản quảng cáo và tự tạo thêm được. Workflow quét động mọi advertiser —
   * chốt cứng danh sách ở đây thì tài khoản mới bị CHẶN, mất chi phí quảng cáo.
   *
   * Dòng báo cáo KHÔNG có `id` ⇒ khoá tự dựng từ (loại report, campaign_id, ngày).
   *
   * PHẢI có "loại report" trong khoá: workflow kéo HAI loại chiến dịch land CHUNG stream này với cùng
   * advertiser_id — auction (endpoint `/report/integrated/get/`, metric `spend`) và GMV Max (endpoint
   * `/gmv_max/report/get/`, metric `cost`). Cùng một chiến dịch một ngày có thể xuất hiện ở CẢ HAI
   * loại nhưng là HAI dòng chi tiêu KHÁC nhau. Nếu khoá chỉ (campaign_id, ngày) thì hai dòng đó chung
   * `externalId` (khác payloadHash nên vẫn land đủ), nhưng `latestPayloads` dựng lại bằng
   * `DISTINCT ON (shopId, externalId)` sẽ chọn 1 vứt 1 ⇒ dựng lại chi phí từ Bronze THIẾU một loại.
   *
   * Phân biệt bằng CHÍNH payload: chỉ auction có `metrics.spend`, chỉ GMV Max có `metrics.cost` (mỗi
   * endpoint yêu cầu bộ metric riêng, cố định trong `keoReport` của n8n). Gắn tiền tố `auction:` cho
   * dòng có `metrics.spend`; GMV Max (và mọi dòng không có `spend`) giữ khoá TRẦN — cố ý không đổi
   * format của loại đang chạy trên prod để dòng GMV Max đã land không phải land lại. `spend` giá trị 0
   * vẫn có key nên `IS NOT NULL` bắt đúng loại (không dùng toán tử `?` jsonb để tránh nhập nhằng với
   * placeholder tham số). `campaign_id` NULL ⇒ cả biểu thức NULL ⇒ dòng bị bỏ + đếm vào skippedNoId.
   *
   * Kéo lại cùng loại + cùng ngày ⇒ trùng khoá + trùng hash ⇒ dedupe; TikTok chỉnh spend hồi tố ⇒
   * khác hash ⇒ land bản mới, giữ lịch sử.
   */
  "tiktokbusiness/report": {
    table: "RawTiktokBusinessReport",
    shops: null,
    arrayPath: ["data", "list"],
    idExpr:
      `(case when elem->'metrics'->>'spend' is not null then 'auction:' else '' end) || ` +
      `(elem->'dimensions'->>'campaign_id') || ':' || left(elem->'dimensions'->>'stat_time_day', 10)`,
  },

  /**
   * HOÁ ĐƠN quảng cáo (Business Center) — số TIỀN THẬT TikTok thu, GỒM VAT.
   *
   * Vì sao cần: `cost` trong report là số CHƯA THUẾ. Hoá đơn: `subtotal` + `tax_amount` (10%) = `amount`.
   * Ba nguồn nối liền nhau — đã kiểm chứng trên hoá đơn thật:
   *   report cost 130.000 (chưa VAT) → hoá đơn amount 143.000 (gồm VAT) → statement TikTok Shop
   *   trừ vào số dư đúng −143.000 (GMV_PAYMENT_FOR_TIKTOK_ADS).
   * ⇒ Chi phí vào P&L phải là số GỒM VAT (hộ kinh doanh không khấu trừ được VAT đầu vào).
   *
   * `shopId` = bc_id (Business Center). `externalId` = transaction_id.
   */
  "tiktokbusiness/invoice": {
    table: "RawTiktokBusinessInvoice",
    shops: null,
    arrayPath: ["data", "transaction_list"],
    // Hoá đơn KHÔNG có field `id` — khoá là `transaction_id`. Quên khai `idExpr` thì mặc định
    // `elem->>'id'` = NULL ⇒ land 0 dòng mà KHÔNG báo lỗi (chỉ đếm vào skippedNoId).
    idExpr: `elem->>'transaction_id'`,
  },

  /**
   * META (Facebook) Marketing API — CHI TIÊU quảng cáo. Envelope `{data:[...], paging:{...}}`.
   *
   * BẤT BIẾN #2: CHỈ lấy `spend`. TUYỆT ĐỐI không lấy conversion value / purchase_roas làm doanh thu.
   *
   * `shopId` = ad account id (`act_...`). Dòng insights không có `id` ⇒ khoá = (campaign, ngày).
   *
   * ⚠️ VAT: `spend` của Meta là số CHƯA THUẾ (giống TikTok). Nhưng Meta KHÔNG có API trả hoá đơn có
   * thuế cho tài khoản trả THẺ (shop đang trả bằng Mastercard) ⇒ phải nhân hệ số VAT cấu hình tay.
   * Chưa chốt được 5% hay 10% ⇒ workflow DỪNG nếu có chi tiêu mà chưa khai hệ số (không ghi số sai).
   */
  "meta/report": {
    table: "RawMetaAdsReport",
    shops: null,
    arrayPath: ["data"],
    idExpr: `(elem->>'campaign_id') || ':' || (elem->>'date_start')`,
  },

  /**
   * SHOPEE — file ví "Transaction Report" (my_balance_transaction) tải TAY (Shopee KHÔNG có API).
   * Import qua UI, KHÔNG qua n8n. Server action tự bọc envelope `{data:[...dòng ví...]}` → ["data"].
   * `shopId` = SHOP_SHOPEE. CHỈ dòng tiền "đã về" (đối soát) — ĐỘC LẬP P&L/doanh thu (bất biến #2).
   *
   * Dòng ví KHÔNG có `id` ⇒ khoá tổng hợp `txnTime|type|orderCode|amount` (bốn thành phần nội tại
   * giao dịch, BẤT BIẾN qua re-export). KHÔNG dùng `runningBalance` làm khoá: điều chỉnh back-date
   * dịch số dư mọi dòng sau nó ⇒ khoá đổi ⇒ land lại ⇒ đếm 2 lần.
   * `coalesce(orderCode,'-')`: dòng Rút Tiền không có mã đơn (NULL) — NULL-concat làm cả biểu thức
   * NULL ⇒ dòng bị bỏ + đếm skippedNoId. Ép '-' để giữ dòng.
   */
  "shopee/wallet": {
    table: "RawShopeeWalletTxn",
    shops: [SHOP_SHOPEE],
    arrayPath: ["data"],
    idExpr:
      `(elem->>'txnTime')||'|'||(elem->>'type')||'|'||coalesce(elem->>'orderCode','-')||'|'||(elem->>'amount')`,
  },
};

export function isBronzeStream(s: string): s is BronzeStream {
  return Object.hasOwn(BRONZE_STREAMS, s);
}
