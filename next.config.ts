import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Next.js mặc định giới hạn Server Action body = 1MB (vẫn đúng ở 16.3.1) — thấp hơn cap logo
    // 2MB của app (MAX_LOGO_BYTES ở settings.ts/shop-info-section.tsx) nên
    // ảnh hợp lệ (~1.4MB PNG) bị framework chặn TRƯỚC khi action chạy validate
    // riêng. Nới lên 3MB để chính app-level validate (không phải framework)
    // là bên từ chối file quá cỡ.
    serverActions: { bodySizeLimit: "3mb" },
    // Next 16.3 bật cache Turbopack cho `next build` theo MẶC ĐỊNH, ghi vào
    // `.next/cache/turbopack`. Cache đó chỉ có ích khi lượt build sau đọc lại được
    // nó — mà `Dockerfile` build trong layer SẠCH mỗi lượt và không mount/khôi phục
    // `.next/cache`, rồi `COPY --from=build --chown=node:node /app ./` lại bê
    // nguyên khối sang runner: image prod mang theo một cache KHÔNG BAO GIỜ được đọc.
    // Đo 2026-08-17: `.next/cache/turbopack` = 128,5 MB. Doc chính thức
    // (`turbopackFileSystemCache`) khuyên đúng ca này: "If your build environment
    // never preserves `.next/cache`, set `turbopackFileSystemCacheForBuild: false`
    // to skip writing a cache that will not be read."
    // GIỮ `turbopackFileSystemCacheForDev` mặc định `true`: cache dev ghi ở
    // `.next/dev/cache/turbopack`, KHÔNG vào image, và ĐƯỢC đọc lại mỗi lần
    // khởi động lại dev server nên nó có ích thật.
    turbopackFileSystemCacheForBuild: false,
  },
  images: {
    // App chỉ hiện thumbnail 32–64px (avatar shop, ảnh sản phẩm) + 1 SVG minh hoạ
    // đăng nhập. 5/6 chỗ <Image> đã tự khai `unoptimized` từng chỗ, và SVG thì
    // Next vốn không tối ưu (trừ khi bật dangerouslyAllowSVG) ⇒ bật toàn cục là
    // no-op về hiển thị, đồng thời bỏ luôn nhánh tối ưu ảnh lúc chạy (hardening).
    // LƯU Ý: cảnh báo `sharp` trong npm audit được vá nhờ Next 16.3.1 kéo
    // sharp ^0.35.3, KHÔNG phải nhờ cờ này.
    unoptimized: true,
  },
};

export default nextConfig;
