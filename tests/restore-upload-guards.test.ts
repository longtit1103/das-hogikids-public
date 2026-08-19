import { gzipSync } from "node:zlib";

import { describe, expect, it, vi } from "vitest";

// Route gọi getSession() đầu tiên — mock phiên hợp lệ để test đi tới các guard
// file. Unit THUẦN, KHÔNG Postgres: mọi case dưới đều return TRƯỚC bước
// pre-restore backup (pg_dump) nên không exec lệnh pg nào.
vi.mock("@/lib/session", () => ({
  getSession: async () => ({ userId: "test-user" }),
  // Route dùng phép kiểm CÓ soi mốc phiên (thu hồi khi đổi mật khẩu) — mock phải khớp.
  getAuthenticatedUserId: async () => "test-user",
  // Route đẩy mốc phiên sau khi nạp xong — các case dưới đều return trước đó, chỉ cần export tồn tại.
  thuHoiMoiPhien: vi.fn(async () => undefined),
}));

import { POST } from "@/app/api/restore/route";

/**
 * Request giả chỉ cần `.formData()` — cố tình KHÔNG đi qua serialize multipart
 * thật (Request(body) sẽ re-parse thành File mới, mất `size` đã patch).
 */
function requestWithFile(file: unknown): Request {
  return {
    formData: async () => ({ get: (key: string) => (key === "file" ? file : null) }),
  } as unknown as Request;
}

/** File thật (content nhỏ) nhưng shadow getter `size` để giả file khổng lồ. */
function fileWithFakeSize(content: Buffer, size: number): File {
  const f = new File([new Uint8Array(content)], "backup.sql.gz");
  Object.defineProperty(f, "size", { value: size });
  return f;
}

describe("POST /api/restore — guard upload (SEC-H1, không cần DB)", () => {
  it("file quá 200MB → 413, KHÔNG đọc bytes vào RAM", async () => {
    const oversized = fileWithFakeSize(Buffer.from("x"), 200 * 1024 * 1024 + 1);
    const res = await POST(requestWithFile(oversized));

    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("quá lớn");
  });

  it("file đúng 200MB (biên) → KHÔNG bị cap chặn (đi tiếp tới detect → 400 vì không phải backup)", async () => {
    // size = đúng ngưỡng nhưng content không phải PGDMP/gzip → phải rơi vào 400
    // "không hợp lệ" của bước detect, KHÔNG phải 413 của cap.
    const atLimit = fileWithFakeSize(Buffer.from("hello"), 200 * 1024 * 1024);
    const res = await POST(requestWithFile(atLimit));

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("không hợp lệ");
  });

  it(".tar.gz backup-toàn-server → 400 qua gunzipHead + assertNotArchive, TRƯỚC mọi bước DB", async () => {
    const tar = Buffer.alloc(1024, 0);
    tar.write("./some-file", 0, "ascii");
    tar.write("ustar", 257, "ascii");
    const tarGz = gzipSync(tar);
    const res = await POST(requestWithFile(new File([new Uint8Array(tarGz)], "backup.tar.gz")));

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("toàn-server");
  });

  it("thiếu file trong form → 400", async () => {
    const res = await POST(requestWithFile(null));
    expect(res.status).toBe(400);
  });
});
