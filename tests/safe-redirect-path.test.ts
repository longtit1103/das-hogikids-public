import { describe, expect, it } from "vitest";

import { isSafeRedirectPath } from "@/lib/safe-redirect-path";

describe("isSafeRedirectPath", () => {
  it("accepts a same-origin relative path", () => {
    expect(isSafeRedirectPath("/don-hang")).toBe(true);
  });

  it("rejects a protocol-relative URL (//evil.com)", () => {
    expect(isSafeRedirectPath("//evil.com")).toBe(false);
  });

  it("rejects a backslash escape (/\\evil.com)", () => {
    expect(isSafeRedirectPath("/\\evil.com")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isSafeRedirectPath("")).toBe(false);
  });

  it("rejects an absolute URL", () => {
    expect(isSafeRedirectPath("http://evil.com")).toBe(false);
  });

  it("rejects a javascript: pseudo-URL", () => {
    expect(isSafeRedirectPath("javascript:alert(1)")).toBe(false);
  });
});
