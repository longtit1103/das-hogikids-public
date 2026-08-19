// Pin múi giờ VN TRƯỚC mọi test (bất biến #3): biên ngày/tháng của date-range,
// daily-series, pnl đều dựa vào TZ process — máy CI/dev lạ không pin sẽ đỏ/lệch ngầm.
process.env.TZ = "Asia/Ho_Chi_Minh";

import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Vitest global setup.
 *
 * Dev's Postgres is shared with prod (one real DB reachable over Tailscale) —
 * so unit tests must NEVER resolve DATABASE_URL against the real `.env`.
 * This overrides DATABASE_URL from TEST_DATABASE_URL before any test file
 * gets a chance to statically import the Prisma singleton
 * (src/lib/prisma.ts reads process.env.DATABASE_URL at module init time).
 */

// Load `.env` into process.env (no "dotenv" dependency needed — Node has a
// built-in loader since v20.6). Real env vars already set take precedence.
const envPath = path.resolve(process.cwd(), ".env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

if (!process.env.TEST_DATABASE_URL) {
  throw new Error(
    "TEST_DATABASE_URL is not set. Refusing to run tests without an explicit test database — dev Postgres is shared with prod."
  );
}

// Guard chống xoá nhầm DB PROD: "TEST_DATABASE_URL tồn tại" chưa đủ — phải chắc nó
// KHÁC DATABASE_URL và trỏ đúng DB test. `process.loadEnvFile()` KHÔNG đè biến shell,
// nên ai lỡ `export TEST_DATABASE_URL=<url prod>` thì deleteAllData()/deleteMany() ở
// các suite bên dưới sẽ chạy thẳng lên DB THẬT.
const testDbUrl = new URL(process.env.TEST_DATABASE_URL);
if (!testDbUrl.pathname.endsWith("_test")) {
  throw new Error(
    `TEST_DATABASE_URL trỏ "${testDbUrl.pathname}" — không phải DB test (phải kết thúc bằng "_test").`
  );
}
if (process.env.DATABASE_URL && new URL(process.env.DATABASE_URL).pathname === testDbUrl.pathname) {
  throw new Error("TEST_DATABASE_URL trùng DATABASE_URL — từ chối chạy (nguy cơ xoá DB thật).");
}

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

// Test luôn chạy hành vi MẶC ĐỊNH (land + transform). Máy dev bật BRONZE_ONLY trong `.env` (đúng
// cách dùng) sẽ khiến Silver rỗng và test đỏ khó hiểu — test nào cần chế độ đó thì tự set lấy.
delete process.env.BRONZE_ONLY;
