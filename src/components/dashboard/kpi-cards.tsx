import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { formatVnd } from "@/lib/format";
import { pnlPercentBase } from "@/lib/reports/pnl-percent-base";
import type { PnlBreakdown } from "@/lib/reports/pnl";
import { cn } from "@/lib/utils";

/**
 * Dải 4 KPI đầu Dashboard — LUÔN Hôm nay/Tháng này, ĐỘC LẬP date-range picker
 * toàn cục (Task 4 brief). `today`/`thisMonth`/`lastMonthSameDays` được tính ở
 * `page.tsx` bằng `calcPnl` trên 3 range CỐ ĐỊNH riêng của hàng KPI này.
 */

function pctChange(current: number, previous: number): number {
  return ((current - previous) / previous) * 100;
}

/** ▲ success khi tăng / ▼ error khi giảm — chỉ số "càng cao càng tốt" (doanh thu). Kỳ trước = 0 → badge "Mới". */
function RevenueDelta({ current, previous }: { current: number; previous: number }) {
  if (previous === 0) {
    return <Badge variant="outline">Mới</Badge>;
  }
  const pct = pctChange(current, previous);
  if (Math.round(Math.abs(pct)) === 0) {
    return <span className="text-xs text-muted-foreground">0% so cùng kỳ tháng trước</span>;
  }
  const up = pct > 0;
  return (
    <span className={cn("text-xs", up ? "text-success" : "text-error")}>
      {up ? "▲" : "▼"} {Math.round(Math.abs(pct))}% so cùng kỳ tháng trước
    </span>
  );
}

function returnBomRatePct(b: PnlBreakdown): number | null {
  const denom = b.orderCount + b.returnBomOrderCount;
  return denom > 0 ? (b.returnBomOrderCount / denom) * 100 : null;
}

function rateTone(pct: number): "text-success" | "text-warning" | "text-error" {
  if (pct <= 5) return "text-success";
  if (pct <= 10) return "text-warning";
  return "text-error";
}

function formatPct1(pct: number): string {
  return `${pct.toFixed(1).replace(".", ",")}%`;
}

/**
 * Delta tỷ lệ hoàn/bom so tháng trước tính bằng ĐIỂM % (current − previous),
 * không phải % tương đối — so % của % dễ đọc sai (VD 2%→4% không phải
 * "tăng 100%" theo trực giác chủ shop). Tăng điểm % = xấu (error), giảm = tốt
 * (success). Không đủ dữ liệu tháng trước (0 đơn) → ẩn delta thay vì chia 0.
 */
function ReturnBomDelta({ current, previous }: { current: number | null; previous: number | null }) {
  if (current === null || previous === null) {
    return null;
  }
  const diff = current - previous;
  if (diff === 0) {
    return <span className="text-xs text-muted-foreground">0 điểm % so tháng trước</span>;
  }
  const up = diff > 0;
  return (
    <span className={cn("text-xs", up ? "text-error" : "text-success")}>
      {up ? "▲" : "▼"} {formatPct1(Math.abs(diff))} điểm so tháng trước
    </span>
  );
}

function CardShell({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="block rounded-xl bg-surface-card p-4 transition-colors hover:bg-surface-soft">
      {children}
    </Link>
  );
}

export function KpiCards({
  today,
  thisMonth,
  lastMonthSameDays,
}: {
  today: PnlBreakdown;
  thisMonth: PnlBreakdown;
  lastMonthSameDays: PnlBreakdown;
}) {
  const marginPct = pnlPercentBase(thisMonth) > 0 ? (thisMonth.netProfit / pnlPercentBase(thisMonth)) * 100 : null;
  const isNegative = thisMonth.netProfit < 0;
  const thisRate = returnBomRatePct(thisMonth);
  const prevRate = returnBomRatePct(lastMonthSameDays);

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {/* ① Doanh thu */}
      <CardShell href="/tai-chinh?tab=loi-lo">
        <p className="text-sm text-muted-foreground">Doanh thu</p>
        <p className="mt-1 font-serif text-2xl text-ink">{formatVnd(today.revenue)}</p>
        <p className="mt-1 text-xs text-muted-foreground">Tháng này: {formatVnd(thisMonth.revenue)}</p>
        <div className="mt-1">
          <RevenueDelta current={thisMonth.revenue} previous={lastMonthSameDays.revenue} />
        </div>
      </CardShell>

      {/* ② Số đơn hợp lệ */}
      <CardShell href="/don-hang">
        <p className="text-sm text-muted-foreground">Số đơn hợp lệ</p>
        <p className="mt-1 font-serif text-2xl text-ink">{today.orderCount.toLocaleString("vi-VN")}</p>
        <p className="mt-1 text-xs text-muted-foreground">Tháng: {thisMonth.orderCount.toLocaleString("vi-VN")}</p>
      </CardShell>

      {/* ③ LN ròng ước tính tháng — card dark nổi bật. Body (label/value/biên) là 1
          Link duy nhất; dòng cảnh báo SKU thiếu giá vốn là Link RIÊNG bên ngoài —
          tránh lồng <a> trong <a> (HTML không hợp lệ). */}
      <div className="rounded-xl bg-surface-dark p-4 text-on-dark">
        <Link href="/tai-chinh?tab=loi-lo" className="block">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm text-on-dark/70">LN ròng ước tính tháng</p>
            <Badge className="border-none bg-on-dark/15 text-on-dark">tạm tính</Badge>
          </div>
          <p className={cn("mt-1 font-serif text-2xl", isNegative ? "text-error" : "text-on-dark")}>
            {formatVnd(thisMonth.netProfit)}
          </p>
          <p className="mt-1 text-xs text-on-dark/70">Biên ròng {marginPct === null ? "—" : formatPct1(marginPct)}</p>
        </Link>
        {/* Link trỏ bộ lọc ĐÃ BÁN, không phải lọc thiếu-giá-vốn cả kho: cảnh báo này đếm SKU ĐÃ
            BÁN, nên dẫn sang danh sách cả kho (đo prod 12/08: 1391 biến thể, chỉ 38 từng bán) là
            bắt chủ shop mò trong đống không liên quan — nhập giá cho biến thể chưa bán ngày nào
            không làm đổi một đồng P&L.
            Hai nhánh CÓ CHỦ ĐÍCH: còn SKU có tên thì Link dẫn tới màn lọc nhập giá vốn; chỉ còn
            dòng KHÔNG rõ SKU thì hiện chữ thường KHÔNG link — nhóm này KHÔNG có Variant nên mọi
            màn Sản phẩm đều không chứa nó, dẫn sang đó chỉ ra danh sách rỗng trong khi cảnh báo
            vẫn đỏ; và nhập giá vốn cũng không sửa được (nguồn Pancake thiếu display_id). */}
        {thisMonth.skuMissingCount > 0 ? (
          <Link
            href="/san-pham?loc=da_ban_thieu_gia_von"
            className="mt-2 inline-block text-xs text-warning hover:underline"
          >
            ⚠ {thisMonth.skuMissingCount} SKU thiếu giá vốn
            {thisMonth.skuUnknownLineCount > 0 && ` + ${thisMonth.skuUnknownLineCount} dòng không khớp SP`}
          </Link>
        ) : thisMonth.skuUnknownLineCount > 0 ? (
          <span className="mt-2 inline-block text-xs text-warning">
            ⚠ {thisMonth.skuUnknownLineCount} dòng hàng không khớp sản phẩm nào — nhập giá vốn không sửa được COGS của chúng
          </span>
        ) : null}
      </div>

      {/* ④ Tỷ lệ hoàn/bom tháng */}
      <CardShell href="/don-hang?trang_thai=hoan_hang,huy_bom">
        <p className="text-sm text-muted-foreground">Tỷ lệ hoàn/bom tháng</p>
        <p className={cn("mt-1 font-serif text-2xl", thisRate === null ? "text-ink" : rateTone(thisRate))}>
          {thisRate === null ? "—" : formatPct1(thisRate)}
        </p>
        <div className="mt-1">
          <ReturnBomDelta current={thisRate} previous={prevRate} />
        </div>
      </CardShell>
    </div>
  );
}
