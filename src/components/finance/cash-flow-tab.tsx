import { formatVnd } from "@/lib/format";
import type { CashFlow, ShopeeCashIn, TiktokCashIn } from "@/lib/reports/cash-flow";
import type { DoiSoatTienVe } from "@/lib/reports/doi-soat-tien-ve";
import type { DoiSoatShopee } from "@/lib/reports/doi-soat-tien-ve-shopee";
import { cn } from "@/lib/utils";

import { DoiSoatSection } from "./doi-soat-section";
import { ShopeeImportButton } from "./shopee-import-button";

/**
 * Tab "Dòng tiền" của hub Tài chính — mức DỰ KIẾN (chưa đối soát). Thuần hiển thị
 * (server component). Tiền vào dự kiến (đơn đã giao) vs tiền ra thật (gồm Nhập
 * hàng) + số dư; "Tiền đã về" thật = ĐA KÊNH (TikTok settlement + ví Shopee import
 * tay). Mọi tiền qua `formatVnd()`.
 */

/** Khối "Tiền đã về" kênh TikTok — net thực nhận + ads đối chiếu + rút bank. */
function TiktokCashInBlock({ cash }: { cash: TiktokCashIn }) {
  return (
    <div className="rounded-xl bg-surface-card p-4">
      <p className="text-sm text-muted-foreground">TikTok — net thực nhận</p>
      <p className="mt-1 font-serif text-xl text-ink">{formatVnd(cash.net)}</p>
      <p className="mt-1 text-xs text-muted-foreground">đã trừ phí + ads, theo ngày sao kê</p>
      <div className="mt-2 flex flex-col gap-1 border-t border-hairline pt-2 text-xs text-muted-foreground">
        <div className="flex justify-between gap-2">
          <span>TikTok tự trừ ads (đối chiếu — theo đơn tạo trong kỳ, trục ngày khác net)</span>
          <span className="tabular-nums whitespace-nowrap">− {formatVnd(cash.adsDeducted)}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span>Đã rút về bank (lũy kế lệnh rút, khác cơ sở kỳ)</span>
          <span className="tabular-nums whitespace-nowrap">{formatVnd(cash.bankPaid)}</span>
        </div>
      </div>
    </div>
  );
}

/** Khối "Tiền đã về" kênh Shopee — net về ví (đã gộp hoàn) + rút bank. */
function ShopeeCashInBlock({ cash }: { cash: ShopeeCashIn }) {
  return (
    <div className="rounded-xl bg-surface-card p-4">
      <p className="text-sm text-muted-foreground">Shopee — net về ví</p>
      <p className="mt-1 font-serif text-xl text-ink">{formatVnd(cash.net)}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Σ tiền vào ví (đã gộp hoàn/điều chỉnh), theo ngày giao dịch · từ file ví import tay
      </p>
      <div className="mt-2 flex flex-col gap-1 border-t border-hairline pt-2 text-xs text-muted-foreground">
        <div className="flex justify-between gap-2">
          <span>Đã rút về bank (lũy kế lệnh rút trong kỳ)</span>
          <span className="tabular-nums whitespace-nowrap">{formatVnd(cash.withdrawn)}</span>
        </div>
      </div>
      {cash.unclassifiedCount > 0 && (
        <p className="mt-2 rounded-lg bg-amber-50 px-2 py-1.5 text-xs text-amber-700">
          ⚠️ {cash.unclassifiedCount} giao dịch loại chưa phân loại ({formatVnd(cash.unclassifiedAmount)}) — CHƯA
          tính vào net về ví. Nếu Shopee thêm loại giao dịch mới, cần bổ sung cách phân loại.
        </p>
      )}
    </div>
  );
}

/** Danh mục chi phí "Nhập hàng" (seed `prisma/seed.ts`) — khoản NẶNG nhất của tiền ra. */
const PURCHASE_CATEGORY_ID = "purchase";

/**
 * Kỳ có ghi khoản "Nhập hàng" chưa? `outBreakdown` đến từ `getExpenseSummary`
 * đã lọc `amount > 0` (chỉ danh mục CÓ phát sinh) nên chỉ cần kiểm tồn tại id —
 * không có mục amount=0 lọt vào. Nhập hàng không vào P&L nhưng CÓ vào tiền ra:
 * kỳ chưa ghi ⇒ số dư lạc quan hơn thực tế, phải nói thẳng ra.
 */
export function hasPurchaseSpend(outBreakdown: CashFlow["outBreakdown"]): boolean {
  return outBreakdown.some((b) => b.categoryId === PURCHASE_CATEGORY_ID);
}

export function CashFlowTab({
  flow,
  isCurrentMonth,
  doiSoat,
  doiSoatShopee,
}: {
  flow: CashFlow;
  isCurrentMonth: boolean;
  /** Đối soát tiền về cấp đơn (TikTok). Vắng → khối đối soát không hiện. */
  doiSoat?: DoiSoatTienVe;
  doiSoatShopee?: DoiSoatShopee;
}) {
  const balanceNegative = flow.balance < 0;
  const { tiktok, shopee } = flow.actualIn;
  const hasActual = tiktok !== null || shopee !== null;
  // Chỉ cảnh báo khi kỳ THẬT SỰ có phát sinh tiền: kỳ trống trơn (chưa đồng bộ,
  // tháng tương lai) thì "chưa ghi Nhập hàng" là nhiễu, không phải cảnh báo.
  const periodHasMoney = flow.expectedIn !== 0 || flow.cashOut !== 0;
  const missingPurchase = periodHasMoney && !hasPurchaseSpend(flow.outBreakdown);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-xl bg-surface-card p-4">
          <p className="text-sm text-muted-foreground">Dự kiến thu — đơn đã giao</p>
          <p className="mt-1 font-serif text-2xl text-ink">{formatVnd(flow.expectedIn)}</p>
          <p className="mt-1 text-xs text-muted-foreground">theo NGÀY ĐẶT · chưa đối soát</p>
        </div>

        <div className="rounded-xl bg-surface-card p-4">
          <p className="text-sm text-muted-foreground">Tiền chi thật</p>
          <p className="mt-1 font-serif text-2xl text-ink">{formatVnd(flow.cashOut)}</p>
          <p className="mt-1 text-xs text-muted-foreground">gồm Nhập hàng đã ghi tay</p>
        </div>

        <div className="rounded-xl bg-surface-card p-4">
          <p className="text-sm text-muted-foreground">Số dư dòng tiền</p>
          <p className={cn("mt-1 font-serif text-2xl", balanceNegative ? "text-error" : "text-ink")}>
            {formatVnd(flow.balance)}
          </p>
          {isCurrentMonth && flow.pendingCount > 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              kỳ đang chạy — còn {flow.pendingCount} đơn chưa giao (xem Đang chờ)
            </p>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">= thu dự kiến − chi thật</p>
          )}
          {missingPurchase && (
            <p className="mt-1 text-xs text-muted-foreground">
              kỳ chưa ghi khoản Nhập hàng nào — số dư chưa trừ tiền nhập hàng, đang lạc quan hơn thực tế
            </p>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-hairline p-4">
        <p className="text-sm text-muted-foreground">Đang chờ (chưa giao)</p>
        <p className="mt-1 font-serif text-xl text-ink">{formatVnd(flow.pendingIn)}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {flow.pendingCount} đơn PENDING/SHIPPING — chưa tính vào số dư
        </p>
      </div>

      {/* Tiền đã về (thật) — ĐA KÊNH. Nút import ví Shopee ở đây (file nuôi cash-IN,
          KHÔNG tạo Expense nên KHÔNG đặt ở /chi-phi). */}
      <div className="rounded-xl border border-hairline p-4">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">Tiền đã về (thật)</p>
          <ShopeeImportButton />
        </div>

        {hasActual ? (
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {tiktok && <TiktokCashInBlock cash={tiktok} />}
            {shopee && <ShopeeCashInBlock cash={shopee} />}
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">
            Sắp có — bật khi có settlement TikTok hoặc import file ví Shopee trong kỳ.
          </p>
        )}

        <p className="mt-3 border-t border-hairline pt-2 text-xs text-muted-foreground">
          Khác &quot;Quảng cáo&quot; ở Tiền ra (chi ads đã ghi sổ, gồm VAT): số ads TikTok trên là khoản TikTok tự trừ,
          chưa VAT. &quot;Tiền đã về&quot; là dòng tiền ĐỐI CHIẾU — độc lập doanh thu/P&amp;L.
        </p>
      </div>

      {doiSoat && <DoiSoatSection doiSoat={doiSoat} tenKenh="TikTok" nguon="quyết toán TikTok qua API" />}
      {/* Hai khối RIÊNG, không gộp số: hai kênh có nguồn dữ liệu và độ phủ khác hẳn nhau — gộp bộ
          đếm lại là làm một con số mất nghĩa để đổi lấy một dòng ngắn hơn. */}
      {doiSoatShopee && (
        <DoiSoatSection doiSoat={doiSoatShopee} tenKenh="Shopee" nguon="ví Shopee nhập tay" />
      )}

      {flow.outBreakdown.length > 0 && (
        <div className="rounded-xl border border-hairline p-4">
          <p className="mb-2 text-sm text-muted-foreground">Tiền ra theo danh mục</p>
          <ul className="flex flex-col gap-1 text-sm">
            {flow.outBreakdown.map((b) => (
              <li key={b.categoryId} className="flex justify-between">
                <span className="text-ink">{b.name}</span>
                <span className="tabular-nums text-ink">{formatVnd(b.amount)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        <p>Số ước tính — chưa đối soát ngân hàng (chưa khớp net vs dự kiến, bank vs net).</p>
        <p>Nhập hàng tính vào tiền ra (khác P&amp;L — P&amp;L trừ COGS hàng đã bán, không trừ tiền nhập kho).</p>
      </div>
    </div>
  );
}
