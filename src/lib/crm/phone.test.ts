import { describe, it, expect } from "vitest";
import { normalizePhone, waLink, waAppLink } from "./phone";

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

describe("normalizePhone — AR", () => {
  it("plain 10-digit mobile AR", () => {
    expect(normalizePhone("11 2345 6789", "AR")).toBe("+541123456789");
  });

  it("already has +54 prefix", () => {
    expect(normalizePhone("+54 11 2345 6789", "AR")).toBe("+541123456789");
  });
});

describe("normalizePhone — BR", () => {
  it("plain 11-digit mobile BR", () => {
    expect(normalizePhone("11 9 1234 5678", "BR")).toBe("+5511912345678");
  });

  it("already has +55 prefix", () => {
    expect(normalizePhone("+55 11 9 1234 5678", "BR")).toBe("+5511912345678");
  });
});

describe("normalizePhone — CL", () => {
  it("plain 9-digit mobile CL", () => {
    expect(normalizePhone("9 1234 5678", "CL")).toBe("+56912345678");
  });

  it("already has +56 prefix", () => {
    expect(normalizePhone("+56 9 1234 5678", "CL")).toBe("+56912345678");
  });
});

describe("normalizePhone — PE", () => {
  it("plain 9-digit mobile PE", () => {
    expect(normalizePhone("9 1234 5678", "PE")).toBe("+51912345678");
  });

  it("already has +51 prefix", () => {
    expect(normalizePhone("+51 912 345 678", "PE")).toBe("+51912345678");
  });
});

describe("normalizePhone — EC (3-digit code 593)", () => {
  it("already has +593 prefix — kept as-is", () => {
    expect(normalizePhone("+593 99 123 4567", "EC")).toBe("+593991234567");
  });

  it("plain 9-digit mobile EC — gets prefixed", () => {
    expect(normalizePhone("99 123 4567", "EC")).toBe("+59399123456" + "7");
  });

  it("digits already start with 593 and length ≥ 10", () => {
    // 593 + 9 digits = 12 digits total (≥ 3+7 = 10)
    expect(normalizePhone("593991234567", "EC")).toBe("+593991234567");
  });
});

describe("normalizePhone — PA (3-digit code 507)", () => {
  it("plain 8-digit number PA — gets prefixed", () => {
    expect(normalizePhone("6123 4567", "PA")).toBe("+50761234567");
  });

  it("already has +507 prefix", () => {
    expect(normalizePhone("+507 6123 4567", "PA")).toBe("+50761234567");
  });

  it("digits already start with 507 and length ≥ 10", () => {
    expect(normalizePhone("50761234567", "PA")).toBe("+50761234567");
  });
});

describe("normalizePhone — CR (3-digit code 506)", () => {
  it("plain 8-digit number CR — gets prefixed", () => {
    expect(normalizePhone("6123 4567", "CR")).toBe("+50661234567");
  });

  it("already has +506 prefix", () => {
    expect(normalizePhone("+506 6123 4567", "CR")).toBe("+50661234567");
  });
});

describe("normalizePhone — ES", () => {
  it("plain 9-digit mobile ES", () => {
    expect(normalizePhone("612 345 678", "ES")).toBe("+34612345678");
  });

  it("already has +34 prefix", () => {
    expect(normalizePhone("+34 612 345 678", "ES")).toBe("+34612345678");
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

describe("normalizePhone — cross-country explicit + prefix", () => {
  it("MX number with + passed to CO context → returned as-is (not prefixed)", () => {
    // +52 1 55 2536 4567 has a leading '+' so it must NOT be prefixed with CO's 57
    expect(normalizePhone("+52 1 55 2536 4567", "CO")).toBe("+5215525364567");
  });

  it("CO number with + passed to CO context → unchanged", () => {
    expect(normalizePhone("+57 300 1234567", "CO")).toBe("+573001234567");
  });

  it("plain CO mobile without + → gets CO prefix (regression)", () => {
    expect(normalizePhone("300 123 4567", "CO")).toBe("+573001234567");
  });

  it("US number with + passed to CO context → returned as-is", () => {
    expect(normalizePhone("+1 305 555 0100", "CO")).toBe("+13055550100");
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

describe("waAppLink", () => {
  it("strips + and returns whatsapp:// scheme URL", () => {
    expect(waAppLink("+573001234567")).toBe("whatsapp://send?phone=573001234567");
  });

  it("handles already-digit string", () => {
    expect(waAppLink("523312345678")).toBe("whatsapp://send?phone=523312345678");
  });

  it("strips all non-digit characters", () => {
    expect(waAppLink("+57 300 123-4567")).toBe("whatsapp://send?phone=573001234567");
  });
});
