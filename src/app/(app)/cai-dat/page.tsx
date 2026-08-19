import type { ReactNode } from "react";

import { AnchorTabs, type AnchorTab } from "@/components/settings/anchor-tabs";
import { ChannelsSection } from "@/components/settings/channels-section";
import { DataSection } from "@/components/settings/data-section";
import { ExpenseCategoriesSection } from "@/components/settings/expense-categories-section";
import { SecuritySection } from "@/components/settings/security-section";
import { ShopInfoSection } from "@/components/settings/shop-info-section";
import { StockThresholdSection } from "@/components/settings/stock-threshold-section";
import { SyncSection } from "@/components/settings/sync-section";
import { TokenExpiryPanel } from "@/components/settings/token-expiry-panel";
import { DoiChieuDonKhoSection } from "@/components/settings/doi-chieu-don-kho-section";
import { DonKetBronzeSection } from "@/components/settings/don-ket-bronze-section";
import { WebhookEventsSection } from "@/components/settings/webhook-events-section";
import { coDuLieuGiaoDich, demAdsMoCoi, demChiPhiKhongDungLai, demDonMoCoi } from "@/lib/actions/data-admin";
import { docTrangThaiSaoLuu } from "@/lib/backup/doc-trang-thai-sao-luu";
import { KET_CUC_CAN_XEM } from "@/lib/ingest/webhook-processor";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { KEY_MOC_VA_TON_KHO, tinhTrangVaTonKho } from "@/lib/ingest/stock-resync-status";
import { KEY_HAN_TOKEN, tinhHanToken } from "@/lib/tokens/token-expiry";
import { doiChieuDonKhoVsSan } from "@/lib/reports/doi-chieu-don-kho";
import { demCanXem, demTonDong, dsDonCanXem } from "@/lib/bronze/ket-cuc-silver";
import { QUA_HAN_PHUT } from "@/lib/bronze/doi-soat-don-con-do";

/**
 * Anchor id CHỐT theo thứ tự — `#ket-noi` phải khớp NGUYÊN VĂN href
 * `/cai-dat#ket-noi` mà phase 4 `expense-table.tsx` và phase 5
 * `channel-ads-expenses-tab.tsx` đã dùng cho "Xem log" dòng ADS_API (đã
 * verify grep 2 file đó trước khi viết file này — không tự đổi tên anchor).
 */
const SETTINGS_TABS: AnchorTab[] = [
  { id: "thong-tin", label: "Thông tin shop" },
  { id: "kenh", label: "Kênh bán" },
  { id: "danh-muc-chi-phi", label: "Danh mục chi phí" },
  { id: "nguong-ton", label: "Tồn kho" },
  { id: "ket-noi", label: "Kết nối & Đồng bộ" },
  { id: "du-lieu", label: "Dữ liệu" },
  { id: "bao-mat", label: "Bảo mật" },
];

/** 1 card `id`-anchor dùng chung cho cả 7 section — Task sau chỉ thay `children`. */
function SettingsSectionCard({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-6 rounded-xl border border-hairline bg-surface-card p-6">
      <div className="flex flex-col gap-1 pb-4">
        <h2 className="font-serif text-lg text-ink">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

export default async function CaiDatPage() {
  const userId = await requireUser("/cai-dat");

  // Webhook Pancake pha 2 — đếm 7 ngày theo kết cục xử lý + sự kiện lạ/lỗi cần người xem.
  // CHỈ đếm source=webhook (dòng live): kho nạp bù (file/db-cu) cố ý KHÔNG xử lý nên đếm vào
  // "chưa xử lý" sẽ báo động giả. KHÔNG kéo cột payload (TEXT to) về server component.
  const tuNgay = new Date(Date.now() - 7 * 86_400_000);

  const [user, channels, categories, settings, syncLogs, trangThaiSaoLuu, hasData, donMoCoi, chiPhiKhongDungLai, adsMoCoi, demWebhook, suKienCanXem, doiChieuKho, tonDongDon, tongDonCanXem, donKetCanXem] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId } }),
    prisma.channel.findMany({ orderBy: { sortOrder: "asc" } }),
    prisma.expenseCategory.findMany({ include: { _count: { select: { expenses: true } } } }),
    // CHỈ lấy đúng key trang này hiển thị — Setting cũng chứa access/refresh token thô của
    // Meta/TikTok, `findMany()` không lọc sẽ kéo hết token về server component vô ích.
    // `KEY_HAN_TOKEN` chỉ gồm các mốc `*ExpireAt`, KHÔNG có key token nào (test khoá điều này).
    // KHÔNG còn "lastBackupAt" — nguồn trạng thái sao lưu nay DUY NHẤT là SyncLog kind BACKUP
    // (xem `docTrangThaiSaoLuu()` ngay bên dưới).
    prisma.setting.findMany({
      where: {
        key: { in: ["defaultLowStockThreshold", KEY_MOC_VA_TON_KHO, ...KEY_HAN_TOKEN] },
      },
    }),
    prisma.syncLog.findMany({ orderBy: { startedAt: "desc" }, take: 10 }),
    // Trạng thái sao lưu đọc RIÊNG dòng BACKUP mới nhất, KHÔNG lấy từ `syncLogs` (take: 10) ở
    // trên — lý do + truy vấn nằm trong `lib/backup/doc-trang-thai-sao-luu.ts` (tách ra khỏi page
    // để test khoá được đường đọc này).
    docTrangThaiSaoLuu(),
    // Phạm vi của `hasData` + `donMoCoi` + `chiPhiKhongDungLai` + `adsMoCoi` nằm trong `data-admin.ts`
    // cùng chỗ
    // với `deleteAllData` — để lượt xóa và lượt đếm không bao giờ lệch danh sách bảng.
    coDuLieuGiaoDich(),
    demDonMoCoi(),
    demChiPhiKhongDungLai(),
    demAdsMoCoi(),
    prisma.rawPancakeWebhookEvent.groupBy({
      by: ["processedAs"],
      where: { source: "webhook", receivedAt: { gte: tuNgay } },
      _count: { _all: true },
    }),
    // CÙNG cửa sổ 7 ngày với dòng đếm: lỗi 3 tuần trước còn nằm trong hộp đỏ trong khi dòng đếm
    // nói "mọi sự kiện đều được nhận diện" là hai thông điệp đá nhau trên cùng một khối.
    // `processedAs: null` = ghi kết cục thất bại — cũng phải hiện.
    prisma.rawPancakeWebhookEvent.findMany({
      where: {
        source: "webhook",
        receivedAt: { gte: tuNgay },
        OR: [{ processedAs: { in: [...KET_CUC_CAN_XEM] } }, { processedAs: null }],
      },
      orderBy: { receivedAt: "desc" },
      take: 8,
      select: { id: true, shopId: true, receivedAt: true, processedAs: true, processedNote: true },
    }),
    // So đơn sàn với bản sao trong Kho Tổng — lưới an toàn chống mất đơn âm thầm khi sàn ngừng
    // trả đơn cũ (log đồng bộ vẫn xanh trong ca đó). Đo prod: ~110ms trên 517 bản sao.
    doiChieuDonKhoVsSan(),
    // Đơn đã land kho thô mà CHƯA dựng xong Sổ — dấu kết cục theo từng dòng, đọc thẳng trạng thái
    // hiện tại nên tự tắt khi hết. `QUA_HAN_PHUT` khớp ngưỡng lượt đối soát đêm bỏ qua dòng vừa land.
    demTonDong(QUA_HAN_PHUT),
    // TỔNG THẬT đơn cần xem (không LIMIT) cho badge; `dsDonCanXem` chỉ lấy 20 dòng đầu để hiển thị.
    demCanXem(),
    dsDonCanXem(20),
  ]);
  const defaultLowStockThreshold = Number(
    settings.find((s) => s.key === "defaultLowStockThreshold")?.value ?? "5",
  );
  const hanToken = tinhHanToken(new Map(settings.map((s) => [s.key, s.value])));
  const vaTonKho = tinhTrangVaTonKho(settings.find((s) => s.key === KEY_MOC_VA_TON_KHO)?.value);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-2xl text-ink">Cài đặt</h1>
          <p className="text-sm text-muted-foreground">Cấu hình shop, kênh bán và dữ liệu</p>
        </div>
        <AnchorTabs tabs={SETTINGS_TABS} />
      </div>

      <SettingsSectionCard
        id="thong-tin"
        title="Thông tin shop"
        description="Tên shop, số điện thoại và logo hiển thị trên toàn app."
      >
        <ShopInfoSection
          shopName={user?.shopName ?? "HogiKids"}
          shopPhone={user?.shopPhone ?? null}
          shopLogoPath={user?.shopLogoPath ?? null}
        />
      </SettingsSectionCard>

      <SettingsSectionCard
        id="kenh"
        title="Kênh bán"
        description="Bật/tắt kênh, phí sàn, phí thanh toán và màu nhận diện."
      >
        <ChannelsSection
          channels={channels.map((c) => ({
            id: c.id,
            name: c.name,
            color: c.color,
            isActive: c.isActive,
            platformFeePct: c.platformFeePct,
            paymentFeePct: c.paymentFeePct,
          }))}
        />
      </SettingsSectionCard>

      <SettingsSectionCard
        id="danh-muc-chi-phi"
        title="Danh mục chi phí"
        description="Danh mục hệ thống + tùy chỉnh dùng cho modal &quot;Thêm chi phí&quot; ở mọi màn."
      >
        <ExpenseCategoriesSection
          categories={categories.map((c) => ({
            id: c.id,
            name: c.name,
            isSystem: c.isSystem,
            isHidden: c.isHidden,
            expenseCount: c._count.expenses,
          }))}
        />
      </SettingsSectionCard>

      <SettingsSectionCard
        id="nguong-ton"
        title="Ngưỡng cảnh báo tồn mặc định"
        description="Áp dụng cho SKU chưa có ngưỡng riêng ở Tồn kho."
      >
        <StockThresholdSection defaultLowStockThreshold={defaultLowStockThreshold} />
      </SettingsSectionCard>

      <SettingsSectionCard
        id="ket-noi"
        title="Kết nối & Đồng bộ"
        description="Hạn token, trạng thái n8n, log đồng bộ Pancake/Meta/TikTok Ads."
      >
        <div className="flex flex-col gap-5">
          {/* Đặt TRƯỚC log đồng bộ: token hết hạn là nguyên nhân gốc của phần lớn lỗi trong log. */}
          <TokenExpiryPanel danhSach={hanToken} />
          <WebhookEventsSection
            demTheoKetCuc={demWebhook.map((d) => ({ processedAs: d.processedAs, soLuong: d._count._all }))}
            canXem={suKienCanXem}
            vaTonKho={vaTonKho}
          />
          {/* Sau webhook, trước log: log xanh KHÔNG chứng minh đủ đơn — phép so với bản sao
              trong kho mới chứng minh được, nên để cạnh nhau cho dễ đối chiếu. */}
          <DonKetBronzeSection
            pendingTotal={tonDongDon.tong}
            oldestPendingAt={tonDongDon.cuNhat}
            tongCanXem={tongDonCanXem}
            canXem={donKetCanXem}
          />
          <DoiChieuDonKhoSection ketQua={doiChieuKho} />
          <SyncSection syncLogs={syncLogs} />
        </div>
      </SettingsSectionCard>

      <SettingsSectionCard
        id="du-lieu"
        title="Dữ liệu"
        description="Sao lưu, phục hồi, dựng lại từ kho thô và xoá dữ liệu giao dịch."
      >
        <DataSection
          trangThaiSaoLuu={trangThaiSaoLuu}
          hasData={hasData}
          shopName={user?.shopName ?? "HogiKids"}
          donMoCoi={donMoCoi}
          chiPhi={chiPhiKhongDungLai}
          adsMoCoi={adsMoCoi}
        />
      </SettingsSectionCard>

      <SettingsSectionCard id="bao-mat" title="Bảo mật" description="Đổi mật khẩu đăng nhập.">
        <SecuritySection />
      </SettingsSectionCard>
    </div>
  );
}
