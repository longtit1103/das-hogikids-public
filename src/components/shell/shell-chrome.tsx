"use client";

import Link from "next/link";
import { useState } from "react";

import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";

/**
 * Owns the mobile nav sheet's open state so the hamburger button (rendered
 * in `Topbar`) and the sheet content (rendered in `Sidebar`) share one
 * source of truth without prop-drilling through the server-only layout.
 */
export function ShellChrome({
  shopName,
  missingCostCount,
  lowStockWarning,
  dataSyncHasError,
  syncHasBacklog,
  saoLuuCoVanDe,
  children,
}: {
  shopName: string;
  missingCostCount: number;
  lowStockWarning: boolean;
  /** CHỈ kind ảnh hưởng số liệu (`DATA_SYNC_KINDS`) — KHÔNG gồm BACKUP, xem banner bên dưới. */
  dataSyncHasError: boolean;
  syncHasBacklog: boolean;
  /** Lượt sao lưu gần nhất LỖI, hoặc quá `GIO_QUA_HAN_SAO_LUU` giờ chưa có bản mới. */
  saoLuuCoVanDe: boolean;
  children: React.ReactNode;
}) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    <div className="min-h-screen bg-canvas md:grid md:grid-cols-[240px_minmax(0,1fr)]">
      <Sidebar
        shopName={shopName}
        missingCostCount={missingCostCount}
        lowStockWarning={lowStockWarning}
        mobileOpen={mobileNavOpen}
        onMobileOpenChange={setMobileNavOpen}
      />
      <div className="flex min-h-screen min-w-0 flex-col">
        <Topbar onOpenMobileNav={() => setMobileNavOpen(true)} />
        <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-6 md:px-6">
          {/*
            Lưới an toàn TOÀN APP: khi Bronze còn backlog hoặc đồng bộ gần đây có lỗi,
            số liệu có thể sai/thiếu. Trước đây cảnh báo chỉ nằm ở trang Cài đặt nên chủ
            shop dễ đọc nhầm số ở Dashboard/Báo cáo. Banner sticky đỏ, dính mọi màn, dẫn
            thẳng về Cài đặt để xử lý. Chi tiết đầy đủ vẫn ở /cai-dat.

            Cờ backlog bật được từ NHIỀU nguồn, không chỉ đơn hàng: cổng đối soát của
            ingest soi cả 3 stream tiền-đã-về (statement/payment TikTok + ví Shopee), mà
            settlement/ví ĐỘC LẬP P&L (bất biến #7). Nên chữ phải nêu cả hai — nói riêng
            "số P&L thiếu" là khẳng định sai về tiền trong đúng ca đó.

            Chữ dẫn về Cài đặt là "xem cách xử lý", KHÔNG hứa "bấm nút là xong": nút
            "Dựng lại từ kho thô" tắt được cảnh báo này NHƯNG chỉ khi lượt chạy sạch
            hoàn toàn — còn kẹt thì nó giữ cờ và nói rõ vướng ở đâu, có ca phải chạy
            lệnh trên minipc mới xong (xem `dungLaiGiaoDichTuKhoTho`).

            Sao lưu (kind BACKUP) có NHÁNH RIÊNG, không trộn vào hai câu trên: backup hỏng
            không làm thiếu một đồng doanh thu nào, nói "số liệu có thể thiếu" là khẳng định
            sai. Nhưng nó cũng KHÔNG được im lặng — bỏ khỏi cảnh báo số liệu mà không đặt gì
            thay thế thì lượt backup hỏng chỉ còn dấu vết ở /cai-dat, nơi chủ shop không vào
            mỗi ngày, trong khi đây đúng là thứ phải biết TRƯỚC lúc cần bản phục hồi. Chi tiết
            ở `NON_DATA_SYNC_KINDS` (`lib/queries/sync-health.ts`).

            Thứ tự ưu tiên khi trùng nhau: backlog → lỗi đồng bộ → sao lưu. Số liệu sai dẫn
            tới quyết định kinh doanh sai ngay hôm nay; sao lưu hỏng chỉ thành thiệt hại khi
            cần phục hồi. Chỉ hiện MỘT câu để banner không thành khối chữ bị lướt qua.
          */}
          {(syncHasBacklog || dataSyncHasError || saoLuuCoVanDe) && (
            <Link
              href="/cai-dat"
              className="sticky top-2 z-20 mb-4 flex flex-col gap-0.5 rounded-lg border border-error bg-error p-3 text-sm text-white shadow-sm transition hover:brightness-95"
            >
              {syncHasBacklog ? (
                <span className="font-semibold">
                  Bronze còn backlog — số liệu có thể thiếu (doanh thu hoặc &quot;Tiền đã về&quot;). Mở Cài đặt để
                  xem cách xử lý.
                </span>
              ) : dataSyncHasError ? (
                <span className="font-semibold">
                  Đồng bộ gần đây có lỗi — số liệu có thể thiếu (doanh thu, chi tiêu quảng cáo hoặc
                  &quot;Tiền đã về&quot;). Mở Cài đặt để kiểm tra.
                </span>
              ) : (
                <span className="font-semibold">
                  Sao lưu đang có vấn đề — số liệu vẫn đủ, nhưng có thể không còn điểm phục hồi mới.
                  Mở Cài đặt để xem chi tiết.
                </span>
              )}
              <span className="text-white/85">Nhấn để mở trang Cài đặt &amp; Đồng bộ →</span>
            </Link>
          )}
          {children}
        </main>
      </div>
    </div>
  );
}
