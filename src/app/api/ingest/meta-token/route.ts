import { z } from "zod";

import { chanRouteKhiDangPhucHoi } from "@/lib/backup/khoa-bao-tri";
import { requireIngestSecret } from "@/lib/ingest/ingest-auth";
import { prisma } from "@/lib/prisma";

/**
 * Kho TOKEN Meta Ads (Setting) — nguồn sự thật duy nhất cho `meta-ads-nightly`.
 *
 * KHÁC TikTok Shop ở chỗ: Meta KHÔNG có refresh_token riêng, và ĐO THẬT (2026-07-14) `fb_exchange_token`
 * KHÔNG tự gia hạn được (trả lại hạn y hệt). Token/quyền hết hạn thì chủ shop phải lấy TAY ở Graph
 * API Explorer rồi chạy `scripts/meta-ads-lay-token.ts` để POST token mới vào kho này. Workflow
 * `meta-ads-nightly` chỉ ĐỌC (GET) kho token — KHÔNG gia hạn, KHÔNG POST token về app.
 *
 * ⚠️ META CÓ **HAI** HẠN, và cái ngắn hơn mới là cái giết ta:
 *   - `expires_at`             — token hết hạn (60 ngày với token cá nhân dài hạn)
 *   - `data_access_expires_at` — quyền TRUY CẬP DỮ LIỆU hết hạn (90 ngày kể từ lần user bấm "Cho phép")
 * Chỉ nhìn `expires_at` thì đúng ngày data-access hết hạn, API từ chối trong khi ta vẫn tưởng token
 * còn sống cả tháng. Reset đồng hồ data access = user vào Graph API Explorer cấp quyền LẠI.
 * (Đo thật 2026-07-14: token còn 60 ngày nhưng data access chỉ còn 9 ngày.)
 *
 * Cả GET lẫn POST đều yêu cầu bearer `INGEST_SECRET` — token KHÔNG BAO GIỜ lộ ra UI.
 */

const KEY_ACCESS_TOKEN = "metaAdsAccessToken";
const KEY_EXPIRE_AT = "metaAdsTokenExpireAt"; // epoch GIÂY — token hết hạn
const KEY_DATA_EXPIRE_AT = "metaAdsDataAccessExpireAt"; // epoch GIÂY — quyền đọc dữ liệu hết hạn
const KEY_SAVED_AT = "metaAdsTokenSavedAt"; // epoch GIÂY

const tokenBodySchema = z.object({
  accessToken: z.string().min(1),
  /** epoch GIÂY. 0 = không hết hạn (System User token của Business Manager). */
  expireAt: z.number().int().nonnegative(),
  dataAccessExpireAt: z.number().int().nonnegative(),
});

export async function POST(req: Request): Promise<Response> {
  const unauthorized = requireIngestSecret(req);
  if (unauthorized) return unauthorized;

  // POST này KHÔNG phải n8n mà là `scripts/meta-ads-lay-token.ts` chạy tay. Nhận 200 rồi bị lượt
  // phục hồi lùi lại = chủ shop tin token mới đã nằm trong kho, còn `meta-ads-nightly` vẫn lặng lẽ
  // dùng token cũ trong bản backup tới lúc nó hết hạn. 503 buộc chạy lại script sau khi phục hồi.
  // GET KHÔNG chặn (bất đối xứng có chủ đích): Meta không có refresh_token xoay vòng để bị đốt nên
  // chặn đọc chỉ làm mất một đêm dữ liệu ads mà không cứu được gì.
  const dangPhucHoi = chanRouteKhiDangPhucHoi();
  if (dangPhucHoi) return dangPhucHoi;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const parsed = tokenBodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ ok: false, error: "invalid body", issues: parsed.error.issues }, { status: 400 });
  }

  const { accessToken, expireAt, dataAccessExpireAt } = parsed.data;
  const savedAt = Math.floor(Date.now() / 1000);

  // Một transaction: không để token mới đứng cạnh hạn cũ (đọc ra sẽ tưởng token sắp chết / còn lâu).
  try {
    await prisma.$transaction(
      (
        [
          [KEY_ACCESS_TOKEN, accessToken],
          [KEY_EXPIRE_AT, String(expireAt)],
          [KEY_DATA_EXPIRE_AT, String(dataAccessExpireAt)],
          [KEY_SAVED_AT, String(savedAt)],
        ] as const
      ).map(([key, value]) =>
        prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
      )
    );
  } catch {
    // KHÔNG đưa err.message vào body: lỗi Prisma có thể chứa giá trị token.
    return Response.json({ ok: false, error: "Lỗi khi lưu token vào kho" }, { status: 500 });
  }

  return Response.json({ ok: true, savedAt });
}

export async function GET(req: Request): Promise<Response> {
  const unauthorized = requireIngestSecret(req);
  if (unauthorized) return unauthorized;

  const rows = await prisma.setting.findMany({
    where: { key: { in: [KEY_ACCESS_TOKEN, KEY_EXPIRE_AT, KEY_DATA_EXPIRE_AT, KEY_SAVED_AT] } },
  });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  // Kho rỗng ⇒ trả accessToken rỗng: workflow rơi về token HẠT GIỐNG trong CONFIG (lần chạy đầu).
  return Response.json({
    ok: true,
    accessToken: map[KEY_ACCESS_TOKEN] ?? "",
    expireAt: Number(map[KEY_EXPIRE_AT] ?? 0),
    dataAccessExpireAt: Number(map[KEY_DATA_EXPIRE_AT] ?? 0),
    savedAt: Number(map[KEY_SAVED_AT] ?? 0),
  });
}
