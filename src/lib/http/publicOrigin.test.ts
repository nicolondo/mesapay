import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appOrigin, publicOrigin } from "./publicOrigin";

/**
 * En producción `req.url` trae el host interno de `next start`
 * (`https://localhost:3301/...`). El origen público sale de los headers.
 */
const INTERNAL = "http://localhost:3301/api/algo";
const req = (headers: Record<string, string>) => new Request(INTERNAL, { headers });

beforeEach(() => {
  vi.stubEnv("APP_PUBLIC_BASE_URL", "");
  vi.stubEnv("NEXTAUTH_URL", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("publicOrigin", () => {
  it("usa x-forwarded-host cuando viene, con el esquema de x-forwarded-proto", () => {
    expect(publicOrigin(req({ host: "localhost:3301", "x-forwarded-host": "mesapay.co", "x-forwarded-proto": "https" }))).toBe("https://mesapay.co");
  });

  it("sin x-forwarded-host usa host (lo que manda nginx) y nunca req.url", () => {
    const origin = publicOrigin(req({ host: "mesapay.co", "x-forwarded-proto": "https" }));
    expect(origin).toBe("https://mesapay.co");
    expect(origin).not.toContain("localhost");
  });

  it("sin x-forwarded-proto: https para hosts públicos, http para localhost", () => {
    expect(publicOrigin(req({ host: "sonymelona.mesapay.co" }))).toBe("https://sonymelona.mesapay.co");
    expect(publicOrigin(req({ host: "localhost:3300" }))).toBe("http://localhost:3300");
    expect(publicOrigin(req({ "x-forwarded-host": "127.0.0.1:3300" }))).toBe("http://127.0.0.1:3300");
  });

  it("toma el primer valor cuando el header viene como lista de proxies", () => {
    expect(publicOrigin(req({ "x-forwarded-host": "mesapay.co, localhost:3301", "x-forwarded-proto": "https, http" }))).toBe("https://mesapay.co");
  });

  it("descarta un x-forwarded-host que no es un host y cae a host", () => {
    expect(publicOrigin(req({ "x-forwarded-host": "evil.com/@x", host: "mesapay.co", "x-forwarded-proto": "https" }))).toBe("https://mesapay.co");
  });

  it("ignora un x-forwarded-proto raro", () => {
    expect(publicOrigin(req({ host: "mesapay.co", "x-forwarded-proto": "javascript" }))).toBe("https://mesapay.co");
  });

  it("acepta un Headers suelto (next/headers en server components)", () => {
    expect(publicOrigin(new Headers({ host: "mesapay.co", "x-forwarded-proto": "https" }))).toBe("https://mesapay.co");
  });

  it("sin ningún host cae al origen configurado, no a req.url", () => {
    const bare = new Headers();
    expect(publicOrigin(bare)).toBe("https://mesapay.co");
    vi.stubEnv("NEXTAUTH_URL", "https://app.mesapay.co/");
    expect(publicOrigin(bare)).toBe("https://app.mesapay.co");
  });
});

describe("appOrigin", () => {
  it("APP_PUBLIC_BASE_URL manda sobre los headers", () => {
    vi.stubEnv("APP_PUBLIC_BASE_URL", "https://mesapay.co/");
    expect(appOrigin(req({ host: "otro.example", "x-forwarded-proto": "https" }))).toBe("https://mesapay.co");
  });

  it("sin APP_PUBLIC_BASE_URL usa el origen público del request", () => {
    expect(appOrigin(req({ host: "mesapay.co", "x-forwarded-proto": "https" }))).toBe("https://mesapay.co");
  });

  it("sin env ni request: NEXTAUTH_URL o mesapay.co", () => {
    expect(appOrigin()).toBe("https://mesapay.co");
    vi.stubEnv("NEXTAUTH_URL", "http://localhost:3300");
    expect(appOrigin()).toBe("http://localhost:3300");
  });

  it("en producción sin APP_PUBLIC_BASE_URL deja un log de error (una sola vez)", () => {
    vi.stubEnv("NODE_ENV", "production");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    appOrigin(req({ host: "mesapay.co" }));
    appOrigin(req({ host: "mesapay.co" }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe("public_origin_env_missing");
    spy.mockRestore();
  });
});
