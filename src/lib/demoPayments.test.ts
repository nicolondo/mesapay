import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * El gate de pagos demo. Estos tests son la red de seguridad para que
 * nadie reintroduzca el agujero P0: `demo_card`/`demo_nequi` aprobaban
 * un pago sin pasarela y sin sesión desde una ruta pública.
 *
 * `env` cachea process.env en el primer acceso, así que cada caso
 * recarga el módulo con vi.resetModules() después de fijar el ambiente.
 */
async function loadWithEnv(overrides: Record<string, string>) {
  vi.resetModules();
  vi.stubEnv("DATABASE_URL", "postgresql://u:p@localhost:5432/test");
  vi.stubEnv("MESAPAY_ALLOW_DEMO_PAYMENTS", undefined);
  for (const [k, v] of Object.entries(overrides)) vi.stubEnv(k, v);
  return import("./demoPayments");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("demoPaymentsAllowed", () => {
  it("está apagado en producción cuando nadie lo prendió a mano", async () => {
    const m = await loadWithEnv({ NODE_ENV: "production" });
    expect(m.demoPaymentsAllowed()).toBe(false);
  });

  it("está prendido en desarrollo — así se prueba la app sin cobrar", async () => {
    const m = await loadWithEnv({ NODE_ENV: "development" });
    expect(m.demoPaymentsAllowed()).toBe(true);
  });

  it("la variable explícita gana sobre NODE_ENV (staging con demos)", async () => {
    const m = await loadWithEnv({
      NODE_ENV: "production",
      MESAPAY_ALLOW_DEMO_PAYMENTS: "true",
    });
    expect(m.demoPaymentsAllowed()).toBe(true);
  });

  it("la variable explícita también sirve para apagarlos en desarrollo", async () => {
    const m = await loadWithEnv({
      NODE_ENV: "development",
      MESAPAY_ALLOW_DEMO_PAYMENTS: "false",
    });
    expect(m.demoPaymentsAllowed()).toBe(false);
  });

  it("un valor raro falla cerrada — no prende demos ni tumba el boot", async () => {
    const m = await loadWithEnv({
      NODE_ENV: "production",
      MESAPAY_ALLOW_DEMO_PAYMENTS: "yes por favor",
    });
    expect(m.demoPaymentsAllowed()).toBe(false);
  });

  it("una variable vacía se trata como no seteada", async () => {
    const m = await loadWithEnv({
      NODE_ENV: "development",
      MESAPAY_ALLOW_DEMO_PAYMENTS: "   ",
    });
    expect(m.demoPaymentsAllowed()).toBe(true);
  });
});

describe("shouldBlockDemoPayment", () => {
  it("bloquea demo_card y demo_nequi en producción", async () => {
    const m = await loadWithEnv({ NODE_ENV: "production" });
    expect(m.shouldBlockDemoPayment("demo_card")).toBe(true);
    expect(m.shouldBlockDemoPayment("demo_nequi")).toBe(true);
  });

  it("NUNCA bloquea demo_cash — es el efectivo de verdad del restaurante", async () => {
    const prod = await loadWithEnv({ NODE_ENV: "production" });
    expect(prod.shouldBlockDemoPayment("demo_cash")).toBe(false);
    const dev = await loadWithEnv({ NODE_ENV: "development" });
    expect(dev.shouldBlockDemoPayment("demo_cash")).toBe(false);
  });

  it("no toca los métodos reales de pasarela", async () => {
    const m = await loadWithEnv({ NODE_ENV: "production" });
    for (const method of [
      "kushki_card",
      "kushki_apple_pay",
      "kushki_pse",
      "kushki_card_terminal",
      "external_terminal",
      "wompi_nequi",
    ]) {
      expect(m.shouldBlockDemoPayment(method)).toBe(false);
    }
  });

  it("deja pasar los demo cuando el ambiente los permite", async () => {
    const m = await loadWithEnv({ NODE_ENV: "development" });
    expect(m.shouldBlockDemoPayment("demo_card")).toBe(false);
    expect(m.shouldBlockDemoPayment("demo_nequi")).toBe(false);
  });
});
