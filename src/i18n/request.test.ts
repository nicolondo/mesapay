import { beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.hoisted(() => ({ getCookie: vi.fn(), headers: vi.fn(), setCookie: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: request.getCookie, set: request.setCookie }),
  headers: request.headers,
}));
vi.mock("next-intl/server", () => ({ getRequestConfig: (resolver: unknown) => resolver }));
import requestConfig from "./request";

const load = requestConfig as unknown as () => Promise<{ locale: string; messages: { menu: { save: string } } }>;
beforeEach(() => { vi.clearAllMocks(); request.getCookie.mockReturnValue(undefined); request.headers.mockResolvedValue(new Headers()); });

describe("request language preference", () => {
  it.each(["es", "en", "pt"])("keeps the explicit %s choice ahead of the device", async locale => {
    request.getCookie.mockReturnValue({ value: locale });
    request.headers.mockResolvedValue(new Headers({ "accept-language": "fr-FR,en;q=0.9" }));
    const config = await load();
    expect(config.locale).toBe(locale);
    expect(config.messages.menu.save).toEqual(expect.any(String));
    expect(request.headers).not.toHaveBeenCalled();
    expect(request.setCookie).not.toHaveBeenCalled();
  });

  it.each([undefined, "fr", "invalid", "EN", "../../en"])("detects the device when the stored choice is invalid: %s", async value => {
    request.getCookie.mockReturnValue(value === undefined ? undefined : { value });
    request.headers.mockResolvedValue(new Headers({ "accept-language": "pt-BR,pt;q=0.9" }));
    expect((await load()).locale).toBe("pt");
    expect(request.setCookie).not.toHaveBeenCalled();
  });

  it("returns Spanish for an unavailable device language, even with English secondary", async () => {
    request.headers.mockResolvedValue(new Headers({ "accept-language": "fr-FR,fr;q=0.9,en;q=0.8" }));
    expect((await load()).locale).toBe("es");
  });

  it("does not pin the automatically detected language or leak another visitor's choice", async () => {
    request.headers.mockResolvedValue(new Headers({ "accept-language": "en-US" }));
    expect((await load()).locale).toBe("en");
    request.headers.mockResolvedValue(new Headers({ "accept-language": "pt-BR" }));
    expect((await load()).locale).toBe("pt");
    expect(request.setCookie).not.toHaveBeenCalled();
  });
});
