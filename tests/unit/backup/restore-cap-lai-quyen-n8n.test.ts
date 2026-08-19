import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { sqlCapQuyenDocN8n } from "@/lib/backup/run-restore";

/**
 * Mỗi lượt phục hồi đều xoá sạch quyền đọc bảng `Setting` của role n8n (`--clean --if-exists` dựng
 * lại bảng, `--no-privileges` bỏ GRANT trong dump, nhánh plain thì xoá cả schema). Không có bước cấp
 * lại thì các workflow n8n chết câm trong khi app vẫn đăng nhập bình thường. Test đọc CÂU SQL phát ra
 * nên không cần Postgres.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const doc = (p: string) => readFileSync(path.join(repoRoot, p), "utf8");

/** Bỏ comment để chỉ soi MÃ THỰC THI (comment có nhắc tên hàm là cố ý). */
function chiMaThucThi(ts: string): string {
  return ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*(\/\/|\*).*$/gm, "");
}

describe("cấp lại quyền đọc cho n8n sau khi phục hồi", () => {
  const sql = sqlCapQuyenDocN8n("app");

  it("cấp ĐÚNG 2 quyền cũ: USAGE trên schema + SELECT bảng Setting", () => {
    expect(sql).toContain('GRANT USAGE ON SCHEMA "app" TO n8n_config_ro');
    expect(sql).toContain('GRANT SELECT ON "app"."Setting" TO n8n_config_ro');
  });

  it("KHÔNG cấp rộng hơn — role này cố ý chỉ đọc đúng 1 bảng", () => {
    expect(sql).not.toMatch(/GRANT\s+ALL/i);
    expect(sql).not.toMatch(/ON\s+ALL\s+TABLES/i);
    expect(sql).not.toMatch(/ALTER\s+DEFAULT\s+PRIVILEGES/i);
    expect(sql).not.toMatch(/INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER/i);
  });

  it("KHÔNG đổi owner, KHÔNG đụng schema/bảng — chỉ cấp quyền", () => {
    expect(sql).not.toMatch(/REASSIGN|OWNER\s+TO|DROP\s+SCHEMA|CREATE\s+SCHEMA/i);
  });

  it("schema lấy theo tham số, KHÔNG hardcode 'app'", () => {
    const khac = sqlCapQuyenDocN8n("kho_thu");
    expect(khac).toContain('GRANT USAGE ON SCHEMA "kho_thu" TO n8n_config_ro');
    expect(khac).not.toContain('"app"');
  });

  it("thiếu role hoặc thiếu bảng thì bỏ qua, không làm hỏng lượt phục hồi", () => {
    expect(sql).toContain("SELECT 1 FROM pg_roles WHERE rolname = 'n8n_config_ro'");
    expect(sql).toContain(`to_regclass('"app"."Setting"')`);
  });

  it("CẢ HAI nhánh phục hồi đều gọi bước cấp lại quyền", () => {
    const ma = chiMaThucThi(doc("src/lib/backup/run-restore.ts"));
    // 1 chỗ khai báo + 1 lời gọi ở nhánh custom + 1 ở nhánh plain.
    expect(ma.match(/capLaiQuyenDocChoN8n/g)?.length).toBe(3);
  });

  it("tên role khớp đường CLI — bash và TS không dùng chung hằng được", () => {
    expect(doc("deploy/restore.sh")).toContain("n8n_config_ro");
  });
});
