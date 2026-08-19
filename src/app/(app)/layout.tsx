import { ShellChrome } from "@/components/shell/shell-chrome";
import { DateRangeProvider } from "@/components/shell/date-range-provider";
import { docTrangThaiSaoLuu } from "@/lib/backup/doc-trang-thai-sao-luu";
import { saoLuuCanBaoDong } from "@/lib/backup/trang-thai-sao-luu";
import { hasBronzeBacklog } from "@/lib/bronze/bronze-only";
import { countMissingCostVariants, hasLowStockVariants } from "@/lib/queries/variants";
import { getRecentDataErrorKinds } from "@/lib/queries/sync-health";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

/**
 * Shared shell for every authenticated screen: guards the route with
 * `requireUser()` (redirects to /dang-nhap otherwise), then renders the
 * sidebar (240px) + top bar chrome around a max-width-1200px content area.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const userId = await requireUser("/");
  const [user, missingCostCount, lowStockWarning, dataErrorKinds, bronzeBacklog, trangThaiSaoLuu] =
    await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { shopName: true } }),
      countMissingCostVariants(),
      hasLowStockVariants(),
      // CHỈ kind ảnh hưởng số liệu — BACKUP cố ý đứng ngoài nhánh này (nó có nhánh banner RIÊNG
      // ngay dưới, vì backup hỏng không làm thiếu số liệu), xem `NON_DATA_SYNC_KINDS`.
      getRecentDataErrorKinds(),
      hasBronzeBacklog(),
      // Sao lưu có nhánh banner riêng: bỏ BACKUP khỏi cảnh báo số liệu mà không đặt gì thay thế
      // thì một lượt backup hỏng chỉ còn dấu vết ở /cai-dat — chủ shop không vào đó mỗi ngày, mà
      // đây đúng là tín hiệu phải biết TRƯỚC khi cần tới bản phục hồi.
      docTrangThaiSaoLuu(),
    ]);

  return (
    <DateRangeProvider>
      <ShellChrome
        shopName={user?.shopName ?? "HogiKids"}
        missingCostCount={missingCostCount}
        lowStockWarning={lowStockWarning}
        dataSyncHasError={dataErrorKinds.length > 0}
        syncHasBacklog={bronzeBacklog}
        saoLuuCoVanDe={saoLuuCanBaoDong(trangThaiSaoLuu.muc)}
      >
        {children}
      </ShellChrome>
    </DateRangeProvider>
  );
}
