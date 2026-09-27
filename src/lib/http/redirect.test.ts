import { describe, expect, it } from "vitest";
import { redirectTo } from "./redirect";

describe("redirectTo", () => {
  it("responde 307 con Location relativo, sin host", () => {
    const res = redirectTo("/t/sonymelona/menu?table=abc");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/t/sonymelona/menu?table=abc");
  });

  it("respeta otro status de redirección", () => {
    expect(redirectTo("/operator", 303).status).toBe(303);
  });

  it.each(["https://evil.com", "//evil.com", "/\\evil.com", "menu"])("rechaza lo que no es una ruta interna: %s", (path) => {
    expect(() => redirectTo(path)).toThrow(/ruta interna/);
  });
});
