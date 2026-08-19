import { adsSourceLabel } from "@/lib/ads-source-label";
import { formatVnd } from "@/lib/format";
import type { QuangCaoTheoChienDich } from "@/lib/reports/quang-cao-chien-dich";

import { formatPct1 } from "./channel-format";

/**
 * Bảng "Hiệu quả quảng cáo theo chiến dịch" ở `/kenh` (nav đã gọi mục này là
 * "Kênh & Marketing" — không đẻ route mới cho một cái bảng).
 *
 * Thuần hiển thị. Tiền lấy từ sổ chi phí nên KHỚP P&L; chỉ số hiển thị/click chỉ
 * có ở Meta. Không có cột ROAS cấp chiến dịch — app không quy được doanh thu về
 * chiến dịch, xem ghi chú trong `quang-cao-chien-dich.ts`.
 */

function soGon(n: number): string {
  return new Intl.NumberFormat("vi-VN").format(n);
}

export function QuangCaoChienDichSection({ dulieu }: { dulieu: QuangCaoTheoChienDich }) {
  // Chiến dịch 0đ trong kỳ là nhiễu (đo 2026-08-18: T6/2026 có 161 chiến dịch mà
  // 159 cái 0đ). Ẩn chúng NHƯNG nói rõ số bị ẩn — cắt câm sẽ đọc ra là "chỉ có
  // ngần này chiến dịch".
  const coChi = dulieu.chienDich.filter((c) => c.chiTieu > 0);
  const soAn = dulieu.chienDich.length - coChi.length;

  // Điều kiện rỗng theo `coChi`, KHÔNG theo tổng số chiến dịch: kỳ mà mọi chiến dịch
  // đều 0đ (đo: T6/2026 có 159/161 dòng 0đ) sẽ render đầu bảng + thân trắng.
  if (coChi.length === 0) {
    return (
      <section className="rounded-xl border border-hairline p-4">
        <h2 className="text-sm text-muted-foreground">Hiệu quả quảng cáo theo chiến dịch</h2>
        <p className="mt-2 text-xs text-muted-foreground">
          Kỳ này chưa ghi nhận chi tiêu quảng cáo nào.
          {soAn > 0 && ` (${soAn} chiến dịch có trong kỳ nhưng chi tiêu 0đ.)`}
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-hairline p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm text-muted-foreground">Hiệu quả quảng cáo theo chiến dịch</h2>
        <p className="font-serif text-lg tabular-nums text-ink">Σ {formatVnd(dulieu.tongChiTieu)}</p>
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-hairline text-left text-xs text-muted-foreground">
              <th className="py-1.5 pr-2 font-normal">Chiến dịch</th>
              <th className="py-1.5 pr-2 font-normal">Nguồn</th>
              <th className="py-1.5 pr-2 text-right font-normal">Chi tiêu</th>
              <th className="py-1.5 pr-2 text-right font-normal">Hiển thị</th>
              <th className="py-1.5 pr-2 text-right font-normal">Click</th>
              <th className="py-1.5 pr-2 text-right font-normal">CTR</th>
              <th className="py-1.5 pr-2 text-right font-normal">CPM</th>
              <th className="py-1.5 text-right font-normal">CPC</th>
            </tr>
          </thead>
          <tbody>
            {coChi.map((c) => (
              <tr key={`${c.nguon}:${c.campaignId}`} className="border-b border-hairline/60 last:border-0">
                <td className="max-w-[280px] truncate py-1.5 pr-2 text-ink" title={c.ten}>
                  {c.ten}
                  {c.khongRoChienDich && c.soDongGop > 1 && (
                    <span className="ml-1 text-xs text-muted-foreground">({c.soDongGop} dòng chi phí)</span>
                  )}
                </td>
                <td className="py-1.5 pr-2 text-xs text-muted-foreground">{adsSourceLabel(c.nguon)}</td>
                <td className="py-1.5 pr-2 text-right tabular-nums text-ink">{formatVnd(c.chiTieu)}</td>
                <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">
                  {c.hienThi === null ? "—" : soGon(c.hienThi)}
                </td>
                <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">
                  {c.click === null ? "—" : soGon(c.click)}
                </td>
                <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">
                  {c.ctr === null ? "—" : formatPct1(c.ctr)}
                </td>
                <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">
                  {c.cpm === null ? "—" : formatVnd(Math.round(c.cpm))}
                </td>
                <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                  {c.cpc === null ? "—" : formatVnd(Math.round(c.cpc))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-col gap-1 border-t border-hairline pt-2 text-xs text-muted-foreground">
        {soAn > 0 && <p>Đã ẩn {soAn} chiến dịch không phát sinh chi tiêu trong kỳ.</p>}
        {dulieu.nguonThieuChiSo.length > 0 && (
          <p>
            Dấu &quot;—&quot; ở {dulieu.nguonThieuChiSo.map(adsSourceLabel).join(", ")}: app chưa kéo chỉ số
            hiển thị/click của nguồn này về (sàn có trả, lượt đồng bộ hiện chỉ xin chi tiêu). Không phải bằng 0.
          </p>
        )}
        <p>
          Chi tiêu lấy từ Sổ chi phí (đã gồm VAT, khớp Lãi/Lỗ) nên CPM/CPC ở đây cao hơn số sàn báo khoảng 10%.
        </p>
        <p>
          Không có ROAS theo chiến dịch: app không quy được doanh thu về từng chiến dịch. ROAS theo KÊNH nằm ở
          các thẻ kênh phía trên.
        </p>
      </div>
    </section>
  );
}
