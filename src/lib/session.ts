import { cookies } from "next/headers";
import type { Prisma, PrismaClient } from "@prisma/client";
import { getIronSession, type SessionOptions } from "iron-session";
import { redirect } from "next/navigation";

import { prisma } from "@/lib/prisma";

export type SessionData = {
  userId?: string;
  /** Mốc phiên lúc đăng nhập — lệch mốc hiện hành ⇒ cookie đã bị thu hồi (xem `docMocPhien`). */
  mocPhien?: string;
  /** Người dùng có tick "Ghi nhớ đăng nhập" không — để cấp lại cookie đúng loại sau khi đổi mật khẩu. */
  ghiNho?: boolean;
};

const SESSION_COOKIE_NAME = "hogikids_session";
const REMEMBER_ME_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 ngày

/** Khoá `Setting` giữ mốc phiên. "0" = chưa từng thu hồi phiên nào. */
const KHOA_MOC_PHIEN = "sessionEpoch";
const MOC_PHIEN_MAC_DINH = "0";

/**
 * Mốc phiên hiện hành. Cookie mang mốc KHÁC mốc này bị coi như chưa đăng nhập.
 *
 * Vì sao cần: iron-session là cookie KÝ, không có bản ghi phiên phía máy chủ — đổi mật khẩu xong
 * thì cookie "ghi nhớ đăng nhập" 30 ngày trên MỌI thiết bị khác VẪN vào được, đúng lúc chủ shop
 * đổi mật khẩu vì nghi bị lộ. Một dòng `Setting` là đủ làm điểm thu hồi mà KHÔNG phải đổi schema
 * Prisma (hợp đồng) — lượt xoá dữ liệu giao dịch cũng cố ý giữ nguyên bảng `Setting`.
 *
 * Thiếu dòng ⇒ mốc "0", mà cookie đời cũ (chưa có trường `mocPhien`) cũng quy về "0" ⇒ nâng cấp
 * bản này KHÔNG đá ai ra khỏi phiên đang dùng; thu hồi chỉ bắt đầu từ lần đổi mật khẩu đầu tiên.
 */
export async function docMocPhien(): Promise<string> {
  const row = await prisma.setting.findUnique({ where: { key: KHOA_MOC_PHIEN } });
  return row?.value ?? MOC_PHIEN_MAC_DINH;
}

/** Client Prisma thường HOẶC client trong `$transaction` — đổi mật khẩu đẩy mốc phiên cùng lượt ghi hash. */
export type ClientPhien = PrismaClient | Prisma.TransactionClient;

/**
 * Đẩy mốc phiên sang giá trị mới ⇒ mọi cookie đã cấp trước đó hết hiệu lực.
 *
 * Nhận `db` để người gọi ghép được vào transaction của mình. Đổi mật khẩu PHẢI làm vậy: hash mới
 * đã COMMIT mà mốc phiên chưa đẩy thì cookie "ghi nhớ 30 ngày" trên máy khác vẫn vào được — đúng
 * cánh cửa hàm này sinh ra để khoá.
 */
export async function thuHoiMoiPhien(db: ClientPhien = prisma): Promise<void> {
  const moc = Date.now().toString();
  await db.setting.upsert({
    where: { key: KHOA_MOC_PHIEN },
    create: { key: KHOA_MOC_PHIEN, value: moc },
    update: { value: moc },
  });
}

function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "SESSION_SECRET phải được set (>= 32 ký tự) trong .env trước khi dùng session."
    );
  }
  return secret;
}

/**
 * Cookie flags chốt (Task 4 brief): httpOnly luôn bật, sameSite=lax, secure
 * CHỈ bật ở production. Trên `http://localhost` (dev), `secure: true` khiến
 * trình duyệt âm thầm không set được cookie — đăng nhập sẽ không hoạt động.
 */
const BASE_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
};

function buildReadSessionOptions(): SessionOptions {
  return {
    password: getSessionSecret(),
    cookieName: SESSION_COOKIE_NAME,
    cookieOptions: BASE_COOKIE_OPTIONS,
  };
}

/**
 * Reads the current request's iron-session (an empty object when no valid
 * cookie is present). Safe to call from Server Components — it only reads.
 */
export async function getSession() {
  const cookieStore = await cookies();
  return getIronSession<SessionData>(cookieStore, buildReadSessionOptions());
}

/**
 * Creates a logged-in session for `userId`. MUST be called from a Server
 * Action or Route Handler (it writes a Set-Cookie). `remember` controls
 * lifetime: `true` persists the cookie for 30 days; `false` produces a real
 * browser session cookie (no Max-Age attribute) that clears when the browser
 * closes — matching the "Ghi nhớ đăng nhập" checkbox semantics.
 */
export async function createSession(userId: string, remember: boolean): Promise<void> {
  const mocPhien = await docMocPhien();
  const cookieStore = await cookies();
  const sessionOptions: SessionOptions = remember
    ? {
        password: getSessionSecret(),
        cookieName: SESSION_COOKIE_NAME,
        ttl: REMEMBER_ME_TTL_SECONDS,
        cookieOptions: BASE_COOKIE_OPTIONS,
      }
    : {
        password: getSessionSecret(),
        cookieName: SESSION_COOKIE_NAME,
        // Explicitly-present `maxAge: undefined` makes iron-session emit a
        // cookie with no Max-Age attribute (a true browser session cookie)
        // and disables server-side seal expiration (ttl forced to 0).
        cookieOptions: { ...BASE_COOKIE_OPTIONS, maxAge: undefined },
      };

  const session = await getIronSession<SessionData>(cookieStore, sessionOptions);
  session.userId = userId;
  session.mocPhien = mocPhien;
  session.ghiNho = remember;
  await session.save();
}

/** Ends the current session (Server Action / Route Handler only). */
export async function destroySession(): Promise<void> {
  const session = await getSession();
  session.destroy();
}

/**
 * `userId` của phiên ĐANG CÒN HIỆU LỰC, hoặc `null`.
 *
 * Khác `getSession()` (chỉ mở cookie): hàm này còn đối chiếu mốc phiên trong cookie với mốc hiện
 * hành, nên cookie cấp trước lần đổi mật khẩu gần nhất sẽ bị từ chối. MỌI chỗ quyết định "đã đăng
 * nhập chưa" phải đi qua đây — bỏ sót một chỗ là mở lại đúng cánh cửa vừa khoá.
 */
export async function getAuthenticatedUserId(): Promise<string | null> {
  const session = await getSession();
  if (!session.userId) return null;
  const mocHienHanh = await docMocPhien();
  if ((session.mocPhien ?? MOC_PHIEN_MAC_DINH) !== mocHienHanh) return null;
  return session.userId;
}

/** Lựa chọn "Ghi nhớ đăng nhập" của phiên hiện tại (để cấp lại cookie đúng loại sau khi đổi mật khẩu). */
export async function docGhiNhoCuaPhien(): Promise<boolean> {
  const session = await getSession();
  return session.ghiNho === true;
}

/**
 * Guards a page: redirects to `/dang-nhap?redirect=<currentPath>` when there
 * is no authenticated user. Returns the authenticated `userId` otherwise.
 */
export async function requireUser(currentPath = "/"): Promise<string> {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    redirect(`/dang-nhap?redirect=${encodeURIComponent(currentPath)}`);
  }
  return userId;
}
