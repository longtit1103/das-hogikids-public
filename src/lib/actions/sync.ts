"use server";

import type { SyncKind } from "@prisma/client";

import type { ActionResult } from "@/lib/actions/action-result";
import type { LatestSync } from "@/lib/actions/sync-types";
import { dangPhucHoi, LOI_DANG_PHUC_HOI } from "@/lib/backup/khoa-bao-tri";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

/** SyncLog kind gần nhất (cho badge "Đồng bộ lúc …" + poll sau khi bấm). */
export async function getLatestSync(kind: SyncKind): Promise<LatestSync> {
  await requireUser();
  const log = await prisma.syncLog.findFirst({ where: { kind }, orderBy: { startedAt: "desc" } });
  if (!log) return null;
  return {
    status: log.status,
    startedAt: log.startedAt.toISOString(),
    finishedAt: log.finishedAt?.toISOString() ?? null,
    error: log.error,
  };
}

/** Bấm "Đồng bộ ngay" → kích webhook n8n (POST rỗng). Không tiết lộ URL xuống client. */
export async function triggerSyncNow(): Promise<ActionResult> {
  await requireUser();
  // Không ghi DB, nhưng vẫn phải chặn: mọi trang n8n đẩy về sẽ bị 503 ở `/api/ingest/raw` TRƯỚC
  // `withSyncLog` ⇒ không có dòng nhật ký nào, badge "Đồng bộ lúc…" giữ mốc cũ, mà action này lại
  // trả ok ⇒ toast xanh nhưng không có gì xảy ra.
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };
  const url = process.env.N8N_SYNC_WEBHOOK_URL;
  if (!url) {
    return { ok: false, error: "Chưa cấu hình kết nối n8n — kiểm tra Cài đặt" };
  }
  try {
    const res = await fetch(url, { method: "POST", signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      return { ok: false, error: "Không gọi được n8n — kiểm tra Cài đặt kết nối" };
    }
    return { ok: true, data: undefined };
  } catch {
    return { ok: false, error: "Không gọi được n8n — kiểm tra Cài đặt kết nối" };
  }
}
