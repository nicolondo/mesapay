import { beforeEach, describe, expect, it, vi } from "vitest";
const cookie = vi.hoisted(() => ({ set: vi.fn(), cookies: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: cookie.cookies }));
import { setLocale } from "./actions";
import { LOCALE_COOKIE } from "./config";

beforeEach(() => { vi.clearAllMocks(); cookie.cookies.mockResolvedValue({ set: cookie.set }); });
describe("remember explicit language", () => {
  it.each(["es", "en", "pt"])("persists %s beyond this browser session and for the whole site", async locale => {
    await setLocale(locale);
    expect(cookie.set).toHaveBeenCalledWith(LOCALE_COOKIE, locale, expect.objectContaining({ path: "/", sameSite: "lax", maxAge: expect.any(Number) }));
    expect(cookie.set.mock.calls[0][2].maxAge).toBeGreaterThan(86400);
  });
  it("replaces the previous choice with the last one", async () => {
    await setLocale("en");
    await setLocale("pt");
    expect(cookie.set).toHaveBeenLastCalledWith(LOCALE_COOKIE, "pt", expect.objectContaining({ path: "/" }));
  });
  it.each(["fr", "EN", "pt-BR", "", "../../en"])("does not store unsupported input: %s", async locale => {
    await setLocale(locale);
    expect(cookie.cookies).not.toHaveBeenCalled();
    expect(cookie.set).not.toHaveBeenCalled();
  });
});
