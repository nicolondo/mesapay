import { describe, it, expect } from "vitest";
import { normalizePhone, waLink } from "./phone";

describe("normalizePhone — CO", () => {
  it("plain 10-digit mobile CO", () => {
    expect(normalizePhone("300 123 4567", "CO")).toBe("+573001234567");
  });

  it("already has +57 prefix", () => {
    expect(normalizePhone("+57 300 1234567", "CO")).toBe("+573001234567");
  });

  it("digits already start with 57 and length >= 11", () => {
    expect(normalizePhone("573001234567", "CO")).toBe("+573001234567");
  });

  it("local landline with area code CO", () => {
    expect(normalizePhone("(604) 444-7602", "CO")).toBe("+576044447602");
  });

  it("returns null for alphabetic input", () => {
    expect(normalizePhone("abc", "CO")).toBeNull();
  });

  it("returns null for too-short input", () => {
    expect(normalizePhone("123", "CO")).toBeNull();
  });
});

describe("normalizePhone — MX", () => {
  it("plain 10-digit mobile MX", () => {
    expect(normalizePhone("33 1234 5678", "MX")).toBe("+523312345678");
  });

  it("already has +52 prefix with spaces", () => {
    expect(normalizePhone("+52 331 234 5678", "MX")).toBe("+523312345678");
  });

  it("+52 prefix with 12 digits total", () => {
    expect(normalizePhone("+523312345678", "MX")).toBe("+523312345678");
  });

  it("digits starting with 52 and length 12", () => {
    expect(normalizePhone("523312345678", "MX")).toBe("+523312345678");
  });
});

describe("normalizePhone — edge cases", () => {
  it("unknown country code returns null", () => {
    expect(normalizePhone("3001234567", "XX")).toBeNull();
  });

  it("exactly 7 digits after prefixing is valid (not null)", () => {
    // 57 + 5 digit number = 7 total digits — valid
    expect(normalizePhone("12345", "CO")).toBe("+5712345");
  });

  it("less than 7 digits after prefixing returns null", () => {
    expect(normalizePhone("123", "CO")).toBeNull();
  });
});

describe("waLink", () => {
  it("strips + and returns wa.me URL", () => {
    expect(waLink("+573001234567")).toBe("https://wa.me/573001234567");
  });

  it("handles already-digit string", () => {
    expect(waLink("523312345678")).toBe("https://wa.me/523312345678");
  });
});
