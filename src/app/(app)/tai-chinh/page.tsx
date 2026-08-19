import Link from "next/link";
import { endOfMonth, format, startOfMonth, subMonths } from "date-fns";

import { PnlTab } from "@/components/bao-cao/pnl-tab";
import { ReportExportButtons } from "@/components/bao-cao/report-export-buttons";
import { CashFlowTab } from "@/components/finance/cash-flow-tab";
import { ExpenseLedgerTab } from "@/components/finance/expense-ledger-tab";
import { resolveRangeFromParams } from "@/lib/date-range";
import { ensureRecurringExpensesForMonths } from "@/lib/expenses/ensure-recurring-expenses";
import { calcPnl } from "@/lib/reports/pnl";
import { computeBackfilledPlatformFee, computePlatformFeeComponents } from "@/lib/reports/platform-fee-breakdown";
import { computeVoucherBreakdown } from "@/lib/reports/voucher-breakdown";
import { computeCashFlow, sumGmv } from "@/lib/reports/cash-flow";
import { doiSoatTienVe } from "@/lib/reports/doi-soat-tien-ve";
import { requireUser } from "@/lib/session";
import { cn } from "@/lib/utils";

type FinanceTab = "loi-lo" | "dong-tien" | "so-chi-phi";

const TAB_ITEMS: { key: FinanceTab; label: string }[] = [
  { key: "loi-lo", label: "Lãi/Lỗ" },
  { key: "dong-tien", label: "Dòng tiền" },
  { key: "so-chi-phi", label: "Sổ chi phí" },
];

function isFinanceTab(value: string | undefined): value is FinanceTab {
  return value === "loi-lo" || value === "dong-tien" || value === "so-chi-phi";
}

// Sổ chi phí dùng thêm nhiều param riêng; chuyển tab chỉ giữ range toàn cục.
type SearchParams = {
  tu?: string;
  den?: string;
  range?: string;
  tab?: string;
  danh_muc?: string;
  kenh?: string;
  nguon?: string;
  q?: string;
  sap_xep?: string;
  trang?: string;
};

/**
 * `/tai-chinh` — hub Tài chính, 3 lăng kính (Lãi/Lỗ · Dòng tiền · Sổ chi phí)
 * chọn qua `?tab=`, mặc định `loi-lo`. Lãi/Lỗ theo THÁNG (chứa `range.to`, dời
 * nguyên từ `/bao-cao`); Sổ chi phí theo range toàn cục. Dòng tiền là
 * placeholder ở phase này (điền ở Phase 3).
 */
export default async function TaiChinhPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireUser();

  const sp = await searchParams;
  const tab: FinanceTab = isFinanceTab(sp.tab) ? sp.tab : "loi-lo";
  // Range chung: ?tu=&den= (Tùy chọn) → ?range=<preset> → this_month.
  const range = resolveRangeFromParams({ tu: sp.tu, den: sp.den, range: sp.range });

  // Chuyển tab giữ range đang xem (tu/den HOẶC preset), bỏ filter riêng của sổ.
  function tabHref(target: FinanceTab): string {
    const params = new URLSearchParams();
    if (target !== "loi-lo") params.set("tab", target);
    if (sp.tu && sp.den) {
      params.set("tu", sp.tu);
      params.set("den", sp.den);
    } else if (sp.range) {
      params.set("range", sp.range);
    }
    const qs = params.toString();
    return qs ? `/tai-chinh?${qs}` : "/tai-chinh";
  }

  let content: React.ReactNode;
  if (tab === "loi-lo") {
    // Tab P&L theo THÁNG dương lịch chứa `range.to`. prevMonth dùng `subMonths`
    // (KHÔNG `previousRange` — tháng dài ngắn khác nhau, xem lịch sử bao-cao).
    const monthRange = { from: startOfMonth(range.to), to: endOfMonth(range.to) };
    const prevMonthStart = startOfMonth(subMonths(monthRange.from, 1));
    const prevMonthRange = { from: prevMonthStart, to: endOfMonth(prevMonthStart) };
    // Backfill chi phí định kỳ cho ĐÚNG 2 tháng render (xem + liền trước) TRƯỚC
    // khi tính — thiếu sẽ báo netProfit cao ảo ở tháng quá khứ.
    await ensureRecurringExpensesForMonths([monthRange.from, prevMonthRange.from]);
    // feeComponents/voucher = chi tiết dòng "Phí sàn" và "Voucher" (diễn giải,
    // KHÔNG đổi tổng — xem platform-fee-breakdown.ts, voucher-breakdown.ts).
    // Tính cho cả tháng trước để dòng con cũng có cột so sánh.
    const [
      monthPnl,
      prevMonthPnl,
      gmv,
      feeComponents,
      prevFeeComponents,
      voucher,
      prevVoucher,
      backfilledFee,
      prevBackfilledFee,
    ] = await Promise.all([
      calcPnl(monthRange),
      calcPnl(prevMonthRange),
      sumGmv(monthRange),
      computePlatformFeeComponents(monthRange),
      computePlatformFeeComponents(prevMonthRange),
      computeVoucherBreakdown(monthRange),
      computeVoucherBreakdown(prevMonthRange),
      computeBackfilledPlatformFee(monthRange),
      computeBackfilledPlatformFee(prevMonthRange),
    ]);
    const printPeriodLabel = `Tháng ${monthRange.from.getMonth() + 1}/${monthRange.from.getFullYear()}`;
    const hasData =
      monthPnl.orderCount > 0 ||
      monthPnl.returnBomOrderCount > 0 ||
      monthPnl.ads + monthPnl.shipping + monthPnl.packaging + monthPnl.returnBom + monthPnl.fixed + monthPnl.other > 0;

    content = (
      <div className="flex flex-col gap-4">
        {/* Chỉ hiện khi in (@media print ẩn topbar) — trang in tự giới thiệu ngữ cảnh. */}
        <div className="hidden print:block">
          <p className="font-serif text-xl text-ink">HogiKids</p>
          <p className="text-sm text-muted-foreground">Lãi/Lỗ — {printPeriodLabel}</p>
        </div>
        <div className="flex justify-end print:hidden">
          <ReportExportButtons
            ky={format(monthRange.from, "yyyy-MM")}
            hasData={hasData}
            data={{
              tab: "pnl",
              monthPnl,
              prevMonthPnl,
              feeComponents,
              prevFeeComponents,
              voucher,
              prevVoucher,
              backfilledFee,
              prevBackfilledFee,
            }}
          />
        </div>
        <PnlTab
          monthPnl={monthPnl}
          prevMonthPnl={prevMonthPnl}
          month={monthRange.from}
          gmv={gmv}
          feeComponents={feeComponents}
          prevFeeComponents={prevFeeComponents}
          voucher={voucher}
          prevVoucher={prevVoucher}
          backfilledFee={backfilledFee}
          prevBackfilledFee={prevBackfilledFee}
        />
      </div>
    );
  } else if (tab === "so-chi-phi") {
    content = <ExpenseLedgerTab sp={sp} range={range} />;
  } else {
    // Dòng tiền theo THÁNG (khớp kỳ tab Lãi/Lỗ). ensureRecurring TRƯỚC khi tính
    // (getExpenseSummary trong computeCashFlow không tự backfill chi phí định kỳ).
    const monthRange = { from: startOfMonth(range.to), to: endOfMonth(range.to) };
    await ensureRecurringExpensesForMonths([monthRange.from]);
    const [flow, doiSoat] = await Promise.all([computeCashFlow(monthRange), doiSoatTienVe(monthRange)]);
    const now = new Date();
    const isCurrentMonth =
      monthRange.from.getFullYear() === now.getFullYear() && monthRange.from.getMonth() === now.getMonth();
    content = <CashFlowTab flow={flow} isCurrentMonth={isCurrentMonth} doiSoat={doiSoat} />;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="print:hidden">
        <h1 className="font-serif text-2xl text-ink">Tài chính</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Lãi/lỗ · dòng tiền vào–ra · sổ chi phí — toàn cảnh tiền của shop
        </p>
      </div>

      <nav className="flex gap-1 rounded-lg bg-surface-soft p-1 print:hidden" aria-label="Lăng kính tài chính">
        {TAB_ITEMS.map((t) => (
          <Link
            key={t.key}
            href={tabHref(t.key)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              tab === t.key ? "bg-canvas text-ink shadow-sm" : "text-muted-foreground hover:text-ink"
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {content}
    </div>
  );
}
