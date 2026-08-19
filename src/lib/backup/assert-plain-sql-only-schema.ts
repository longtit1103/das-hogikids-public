/**
 * Chặn restore đè object NGOÀI schema đích trên đường PLAIN (`.sql.gz`). Khác đường
 * custom (`assert-dump-schema.ts`): KHÔNG có `-n <schema>` của pg_restore chốt cứng
 * phía sau, nên đây là hàng rào DUY NHẤT — guard fail-closed, thà từ chối oan.
 */

import {
  maskSingleQuotedStrings,
  stripCopyStdinData,
  stripDollarQuoted,
  stripSqlComments,
  COPY_END_LINE,
} from "./sql-text-scanner-plain-dump";

/**
 * Các schema HỆ THỐNG của Supabase self-host. Dùng làm denylist cho đường plain-gzip
 * (KHÔNG có backstop `-n schema` như đường custom) — bất kỳ tham chiếu qualified tới
 * các schema này (vd `auth.users`, `storage.objects`) hay `DROP SCHEMA auth` đều là
 * dấu hiệu dump full-DB Supabase → TỪ CHỐI để không xoá/đè dữ liệu hệ thống.
 *
 * `export` để test parity đọc được: danh sách này có BẢN SONG SINH bằng bash ở
 * `deploy/restore.sh` (`SYSTEM_SCHEMAS="…"`), hai bên phải khớp tuyệt đối —
 * `tests/unit/backup/system-schemas-twin-shell-vs-ts.test.ts` ép điều đó.
 */
export const SUPABASE_SYSTEM_SCHEMAS = [
  "auth",
  "storage",
  "vault",
  "realtime",
  "graphql",
  "extensions",
  "supabase_functions",
  "_realtime",
  "pgbouncer",
  "net",
  "cron",
  "pgsodium",
  "supabase_migrations",
] as const;

/**
 * Schema "toàn cục" được PHÉP qualify trong DDL/DML mà KHÔNG coi là ngoài đích: pg_dump
 * plain vẫn tham chiếu chúng hợp lệ. (`set_config` nằm trong `pg_catalog` và câu
 * `SELECT pg_catalog.set_config('search_path', '', false)` KHÔNG bắt đầu bằng động từ
 * DDL/DML nên không bao giờ lọt vào guard (e); vẫn allowlist `pg_catalog` cho chắc.)
 */
const QUALIFIER_ALLOWLIST = new Set(["pg_catalog", "information_schema"]);

/**
 * Động từ DDL/DML mà pg_dump plain phát ra ở ĐẦU câu lệnh, theo sau là object
 * schema-qualified. Dùng cho guard (e) — đối xứng với TOC guard.
 */
const DDL_DML_VERBS = "CREATE|ALTER|DROP|TRUNCATE|INSERT|UPDATE|DELETE|COPY|GRANT|REVOKE|COMMENT|LOCK";

/**
 * Các dòng meta-command psql mà `pg_dump -Fp` THẬT phát ra — allowlist HẸP của guard (g).
 * Mọi `\` khác đều bị từ chối.
 *
 *  • `\.` — mốc kết payload `COPY … FROM stdin`. Neo CHÍNH XÁC như `COPY_END_LINE`: COPY
 *    text format chỉ nhận dòng đúng `\.`, nên `  \.` thụt đầu dòng là DỮ LIỆU → phải chặn.
 *  • `\restrict <token>` / `\unrestrict <token>` — bản vá bảo mật PostgreSQL 08/2025
 *    (15.14 / 16.10 / 17.6 / 18.0 trở lên) khiến `pg_dump -Fp` LUÔN bọc file giữa cặp này:
 *    nó BẬT chế độ hạn chế của psql để chính các meta-command bị nhồi vào dữ liệu KHÔNG
 *    chạy được. Tức đây là dòng LÀM TĂNG an toàn, không phải tấn công.
 *
 *    ĐO THẬT 31/07 trên prod: container app (`hogikids-app`, `postgresql-client-15` cài từ
 *    PGDG KHÔNG ghim minor) có `pg_dump 15.18`, và `pg_dump -Fp -n app` của nó phát
 *    `\restrict <token>` ở dòng 5 + `\unrestrict <token>` ở dòng cuối (token trùng nhau,
 *    63 ký tự chữ-số). Trước khi allowlist, guard từ chối MỌI file .sql.gz do chính đời
 *    pg_dump hiện tại sinh ra — từ-chối-oan đúng loại nguy hiểm nhất với đường DR.
 *    (`supabase-db` vẫn là 15.8 nên dump tạo TỪ TRONG container DB chưa có 2 dòng này —
 *    allowlist phải chấp nhận cả hai đời.)
 */
const PG_DUMP_META_ALLOW = [
  COPY_END_LINE,
  /^\\restrict [A-Za-z0-9_]+$/,
  /^\\unrestrict [A-Za-z0-9_]+$/,
];

/**
 * Quét SQL plain (đường .sql.gz — KHÔNG có `-n schema` chốt cứng nên guard phải MẠNH).
 * Từ chối khi:
 *  (a) CREATE/DROP/ALTER SCHEMA <tên> với tên ≠ target (nghi dump full-DB);
 *  (b) tham chiếu qualified tới schema HỆ THỐNG Supabase (vd `auth.users`, `storage.objects`,
 *      `vault.secrets`) — thảm hoạ đè/xoá dữ liệu hệ thống chung;
 *  (c) meta-command `\connect` / `\c` (có thể chuyển sang DB khác, thoát khỏi -d đích);
 *  (d) câu lệnh `SET search_path` — `pg_dump` plain THẬT KHÔNG BAO GIỜ phát ra câu này
 *      (nó dùng `SELECT pg_catalog.set_config('search_path', '', false)`), nên bất kỳ
 *      `SET search_path` nào trong dump là BẤT THƯỜNG: có thể là file bị chỉnh tay để
 *      kèm `SET search_path = auth;` rồi ghi UNQUALIFIED (không `auth.`) — bypass guard
 *      (b) vì (b) chỉ bắt tham chiếu CÓ qualifier. Fail-closed: từ chối luôn, không cố
 *      phân biệt vô hại/ác ý.
 *  (e) ĐỐI XỨNG với TOC guard: object schema-qualified nhắm schema ≠ đích (KHÔNG chỉ
 *      schema hệ thống ở (b)). Chặn dump plain tiền-migration của DB `public` cũ (vd
 *      `CREATE TABLE public."Order" …`) — thứ (a)+(b) đều bỏ lọt vì không có CREATE
 *      SCHEMA và `public` không phải schema hệ thống (H3). Chỉ xét qualifier ĐẦU TIÊN
 *      của mỗi câu (object đang bị ghi) — tham chiếu schema khác trong THÂN view/function
 *      KHÔNG bị chặn (đúng như TOC guard chỉ xét namespace của chính object).
 *  (f) DẠNG HÀM của (d): `set_config('search_path', <khác rỗng>, …)`. `pg_dump` plain
 *      THẬT chỉ phát ra `set_config('search_path', '', false)` (chuỗi RỖNG = ép mọi object
 *      phải qualified). Guard (d) chỉ bắt câu lệnh `SET search_path`, KHÔNG bắt lời gọi hàm
 *      → dump chỉnh tay dùng `SELECT set_config('search_path','auth',false);` rồi ghi
 *      UNQUALIFIED sẽ né cả (b) (chuỗi 'auth' bị nháy nên không soi được) lẫn (e) (SELECT
 *      không phải verb ghi). Fail-closed: CHỈ cho đúng dạng chuỗi rỗng `''`.
 *  (g) meta-command psql CÒN LẠI (`\!`, `\copy … TO PROGRAM`, `\i`, `\o|sh`, `\g|sh`, `\setenv`,
 *      `\lo_import`…). Guard (c) chỉ bắt `\connect`/`\c`. psql thực thi lệnh `\…` trong file nạp
 *      bằng `-f` và không tắt được ⇒ đây là đường CHẠY LỆNH trên máy chủ, không chỉ là đè schema.
 *      Chỉ ALLOWLIST đúng các dạng `pg_dump` plain THẬT phát ra (xem `PG_DUMP_META_ALLOW`).
 *  (h) chuỗi nháy đơn/kép TRẢI QUA XUỐNG DÒNG ở NGOÀI khối COPY (ném từ `lexSqlLine`).
 *      Kẻ tấn công dùng nó để giấu một mốc `COPY … FROM stdin;` GIẢ: chế độ bỏ-payload mở
 *      tới dòng `\.` và xoá cả vùng đó khỏi bản soi ⇒ (b)/(e)/(g) mù trong khi psql vẫn chạy
 *      các câu ở giữa. Fail-closed như đã làm với `SET search_path`.
 *
 *      GIỚI HẠN ĐÃ BIẾT (chấp nhận): pg_dump CÓ THỂ phát ra chuỗi đa dòng nếu DB chứa literal
 *      có ký tự xuống dòng ngoài khối COPY — thực tế chỉ gặp ở `COMMENT ON … IS '…\n…'` hoặc
 *      DEFAULT/CHECK nhiều dòng. Repo này không sinh dạng đó (Prisma không phát COMMENT ON;
 *      đã đối chiếu dump plain THẬT của prod 31/07, cả bản schema-only lẫn bản có dữ liệu:
 *      KHÔNG dòng nào lệch parity nháy). Nếu về sau gặp từ-chối-oan, lối thoát vận hành là
 *      nạp bản `.dump` custom (đường có `pg_restore -n <schema>` chốt cứng) — KHÔNG nới guard
 *      này, vì nới là mở lại đúng lỗ hổng trên.
 */
export function assertPlainSqlOnlySchema(rawSql: string, schema: string): void {
  // Chuẩn hoá xuống dòng NGAY TỪ ĐẦU: file CRLF để lại `\r` cuối dòng làm lệch mọi mốc
  // neo-cuối-dòng (`^\.$`, `… FROM stdin;$`) ⇒ payload COPY không được bỏ và dump thật bị
  // từ chối oan. Làm một lần ở đây thay vì rải `\r` handling khắp các guard.
  const sql = rawSql.replace(/\r\n?/g, "\n");

  // Bỏ payload COPY MỘT LẦN rồi dùng lại cho (b)/(e)/(f)/(g) — đây cũng là nơi guard (h)
  // ném lỗi, nên mọi guard phía sau đều soi trên bản đã đảm bảo "không có chuỗi đa dòng".
  const noCopy = stripCopyStdinData(sql);

  // (a) CREATE/DROP/ALTER SCHEMA <tên> ≠ target. Bao cả IF [NOT] EXISTS.
  const schemaDdl =
    /\b(CREATE|DROP|ALTER)\s+SCHEMA\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?"?([a-zA-Z_][\w$]*)"?/gi;
  for (const m of sql.matchAll(schemaDdl)) {
    const [, verb, name] = m;
    if (name !== schema) {
      throw new Error(
        `SQL ${verb.toUpperCase()} SCHEMA '${name}' ≠ '${schema}' — TỪ CHỐI (nghi dump full-DB / đè schema hệ thống).`,
      );
    }
  }

  // (b) Câu lệnh GHI/XOÁ nhắm tới schema HỆ THỐNG Supabase (vd `TRUNCATE storage.objects`,
  // `CREATE TABLE auth.users(...)`, `DELETE FROM vault.secrets`). Gate bằng ĐỘNG TỪ mutating
  // + khoảng đệm KHÔNG chứa nháy/`;`/xuống-dòng: pg_dump gói dữ liệu text trong nháy, nên
  // `auth.` xuất hiện trong CHUỖI dữ liệu (URL/prose) bị chặn ở dấu nháy → không false-positive;
  // còn qualifier THẬT (`verb … auth.users`) nằm ngoài nháy nên vẫn bắt được. Qualifier hệ
  // thống trong plain dump là KHÔNG nháy (tên toàn chữ thường, không phải từ khoá).
  const VERBS =
    "DROP|CREATE|ALTER|TRUNCATE|DELETE\\s+FROM|INSERT\\s+INTO|UPDATE|COPY|GRANT|REVOKE|COMMENT\\s+ON|LOCK|REINDEX|REFRESH|CLUSTER";
  // Soi bản đã bỏ payload COPY + che chuỗi nháy (data tab-phân-tách / chuỗi có thể chứa
  // `sys.` giống qualifier). GIỮ thân dollar-quote để vẫn bắt DO-block / function body ghi
  // schema hệ thống (vd `DO $$ BEGIN DELETE FROM auth.users; END $$;`).
  const scanSys = maskSingleQuotedStrings(noCopy);
  for (const sys of SUPABASE_SYSTEM_SCHEMAS) {
    if (sys === schema) continue; // nếu schema đích trùng tên (không xảy ra với app) thì bỏ.
    // Khoảng đệm `[^;'"]*?` KHÔNG loại `\n`: câu lệnh trải nhiều dòng (verb dòng trên,
    // qualifier dòng dưới) trong một file .sql.gz chỉnh tay vẫn phải bị bắt. Ranh giới câu
    // vẫn là `;`/nháy nên qualifier THẬT (ngoài nháy) trong cùng câu mới match.
    const dangerous = new RegExp(`\\b(?:${VERBS})\\b[^;'"]*?\\b${sys}\\.`, "i");
    if (dangerous.test(scanSys)) {
      throw new Error(
        `SQL thao tác trên schema hệ thống Supabase '${sys}' — TỪ CHỐI để không đè dữ liệu hệ thống.`,
      );
    }
  }

  // (c) Meta-command \connect / \c — chuyển sang DB khác, thoát khỏi `-d` đích. Các meta-command
  // khác do (g) chặn. Dump schema hợp lệ không có câu nào trong hai nhóm này.
  if (/^\s*\\c(?:onnect)?\b/im.test(sql)) {
    throw new Error("SQL chứa meta-command \\connect — TỪ CHỐI (có thể chuyển sang DB khác).");
  }

  // (d) `SET search_path` — chỉ khớp ở ĐẦU câu lệnh (đầu chuỗi, hoặc ngay sau `;`/xuống
  // dòng) để KHÔNG khớp vào bên trong chuỗi dữ liệu có nháy (vd note khách hàng chứa chữ
  // "set search_path"). pg_dump plain THẬT không bao giờ phát ra SET search_path (dùng
  // set_config) nên đây là dấu hiệu file bị chỉnh sửa/giả mạo. Soi bản đã bỏ thân dollar-quote
  // (thân function KHÔNG chạy lúc restore; bỏ trước để scanner theo-dõi-nháy không bị desync vì
  // nháy lẻ trong thân $$…$$) rồi bỏ comment (không né bằng `SET/**​/search_path`).
  if (
    /(?:^|;|\r?\n)[ \t]*SET\s+(?:(?:SESSION|LOCAL)\s+)?search_path\b/i.test(
      stripSqlComments(stripDollarQuoted(sql)),
    )
  ) {
    throw new Error(
      "SQL chứa câu lệnh SET search_path — pg_dump plain THẬT dùng pg_catalog.set_config('search_path', '', false), KHÔNG BAO GIỜ phát ra SET search_path — TỪ CHỐI (nghi file bị chỉnh sửa để né guard schema hệ thống).",
    );
  }

  // (e) Đối xứng với TOC guard. Che dữ liệu (COPY payload + thân dollar-quote + chuỗi
  // nháy đơn) TRƯỚC khi soi, để `.`/`;` trong note đơn/URL không bị hiểu nhầm là câu
  // lệnh. Neo mỗi match ở ĐẦU câu (đầu chuỗi hoặc ngay sau `;`) và lấy qualifier `schema.`
  // ĐẦU TIÊN đứng trước nháy/`;`/xuống-dòng — chính là namespace của object đang bị ghi.
  const scan = maskSingleQuotedStrings(stripDollarQuoted(noCopy));
  // Neo verb ở ĐẦU CÂU (`^` per-line hoặc ngay sau `;`); cho phép whitespace LIÊN-DÒNG
  // giữa mốc câu↔verb (`[ \t\r\n]*`) và giữa verb↔qualifier (`[^;'"]*?`) để câu ghi object
  // trải nhiều dòng (verb dòng trên, `schema.object` dòng dưới) không lọt. Ranh giới câu
  // vẫn là `;`/nháy; dữ liệu (COPY/dollar/nháy) đã bị che ở `scan` nên không soi nhầm.
  const foreignQualifier = new RegExp(
    `(?:^|;)[ \\t\\r\\n]*(?:${DDL_DML_VERBS})\\b[^;'"]*?"?([a-zA-Z_][\\w$]*)"?\\.`,
    "gim",
  );
  for (const m of scan.matchAll(foreignQualifier)) {
    const ns = m[1];
    if (ns === schema || QUALIFIER_ALLOWLIST.has(ns)) continue;
    throw new Error(
      `SQL thao tác object schema '${ns}' ≠ '${schema}' — TỪ CHỐI (nghi dump full-DB / schema ngoài đích).`,
    );
  }

  // (f) `set_config('search_path', <khác rỗng>, …)` — dạng HÀM của (d). Soi trên bản đã bỏ
  // payload COPY + thân dollar-quote (set_config trong thân function chỉ chạy khi GỌI hàm,
  // KHÔNG chạy lúc restore → không phải vector; bỏ để tránh false-positive) + bỏ comment (né
  // `set_config/**​/(…)`), KHÔNG che nháy đơn (cần đọc literal đối số). Bắt cả
  // `pg_catalog.set_config(...)` (khớp từ `set_config(`). Chỉ chấp nhận đối số thứ 2 = chuỗi
  // rỗng `''`; mọi giá trị khác (literal 'auth' hoặc biểu thức `current_setting(...)`) → TỪ CHỐI.
  const setConfigSearchPath = /set_config\s*\(\s*'search_path'\s*,\s*([^)]*?)\s*(?:,|\))/gi;
  const fScan = stripSqlComments(stripDollarQuoted(noCopy));
  for (const m of fScan.matchAll(setConfigSearchPath)) {
    if (m[1] !== "''") {
      throw new Error(
        "SQL chứa set_config('search_path', …) với giá trị KHÁC chuỗi rỗng — pg_dump plain THẬT chỉ dùng set_config('search_path', '', false) — TỪ CHỐI (nghi file bị chỉnh sửa để né guard schema hệ thống).",
      );
    }
  }

  // (g) Meta-command psql CÒN LẠI. `psql -f <file>` (và cả stdin) THỰC THI mọi lệnh `\…`, KHÔNG
  // có cờ nào tắt được: `\!` chạy shell (container app chạy root), `\copy … TO PROGRAM 'cmd'` cũng
  // chạy shell, `\i` nạp thêm file, `\o | sh` / `\g | sh` đổ output vào shell. Guard (c) chỉ bắt
  // `\connect`/`\c` nên các dạng còn lại lọt sạch. Mọi `\` KHÔNG nằm trong allowlist hẹp
  // `PG_DUMP_META_ALLOW` (sau khi đã che dữ liệu) đều BẤT THƯỜNG → từ chối.
  //
  // BẮT BUỘC soi trên bản ĐÃ bỏ payload COPY: trong khối dữ liệu, `\N` (NULL marker) và `\\`
  // (escape) là DỮ LIỆU cực phổ biến — áp thẳng lên SQL thô sẽ TỪ CHỐI OAN mọi dump thật, đúng
  // loại lỗi mà file này coi là nguy hiểm hơn cả bỏ lọt (tập cho vận hành viên thói quen tắt guard).
  // Bỏ luôn thân dollar-quote (psql theo dõi `$$` nên `\` trong đó KHÔNG là meta-command), bỏ
  // comment, và che chuỗi nháy đơn (regex kiểu '^\d+$' là dữ liệu hợp lệ — repo có sẵn dạng này
  // trong migration của bảng Setting).
  //
  // KHÔNG neo đầu dòng: psql nhận meta-command ở mọi vị trí ngoài chuỗi/comment, nên `SELECT 1 \g
  // | sh` (backslash GIỮA dòng) sẽ lọt nếu chỉ soi `^[ \t]*\\`. Fail-closed = "không còn `\` lạ".
  const gScan = maskSingleQuotedStrings(stripSqlComments(stripDollarQuoted(noCopy)));
  for (const line of gScan.split("\n")) {
    if (!line.includes("\\")) continue;
    if (PG_DUMP_META_ALLOW.some((allowed) => allowed.test(line))) continue;
    throw new Error(
      `SQL chứa meta-command psql (${JSON.stringify(line.trim().slice(0, 40))}) — psql thực thi ` +
        `lệnh \\… khi nạp file và KHÔNG tắt được; pg_dump plain THẬT chỉ phát ra \\. , \\restrict ` +
        `và \\unrestrict — TỪ CHỐI (nghi file bị chỉnh sửa để chạy lệnh trên máy chủ).`,
    );
  }
}
