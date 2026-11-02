import { describe, expect, it } from "vitest";
import { defaultOnlineMethod, onlineMethodsInOrder } from "./defaultOnlineMethod";

/**
 * Medio preseleccionado al abrir un link de pago: Apple Pay si el aparato
 * lo admite y el comercio lo habilitó; si no, tarjeta y después PSE.
 */
const ALL = ["kushki_apple_pay", "kushki_card", "kushki_pse", "cash", "external_terminal"];

describe("defaultOnlineMethod", () => {
  it("preselecciona Apple Pay cuando está disponible y habilitado", () => {
    expect(defaultOnlineMethod({ applePayAvailable: true, enabledMethods: ALL, kushkiReady: true })).toBe("kushki_apple_pay");
    expect(onlineMethodsInOrder({ applePayAvailable: true, enabledMethods: ALL, kushkiReady: true })).toEqual([
      "kushki_apple_pay",
      "kushki_card",
      "kushki_pse",
    ]);
  });

  it("sin Apple Pay en el aparato, el orden de siempre: tarjeta y después PSE", () => {
    expect(defaultOnlineMethod({ applePayAvailable: false, enabledMethods: ALL, kushkiReady: true })).toBe("kushki_card");
    expect(onlineMethodsInOrder({ applePayAvailable: false, enabledMethods: ALL, kushkiReady: true })).toEqual([
      "kushki_card",
      "kushki_pse",
    ]);
  });

  it("Apple Pay disponible pero no habilitado por el comercio no se ofrece", () => {
    expect(
      defaultOnlineMethod({ applePayAvailable: true, enabledMethods: ["kushki_card", "kushki_pse"], kushkiReady: true }),
    ).toBe("kushki_card");
  });

  it("sin tarjeta habilitada cae a PSE; los medios de mostrador nunca entran", () => {
    expect(defaultOnlineMethod({ applePayAvailable: false, enabledMethods: ["kushki_pse", "cash"], kushkiReady: true })).toBe(
      "kushki_pse",
    );
    expect(onlineMethodsInOrder({ applePayAvailable: true, enabledMethods: ["cash", "external_terminal"], kushkiReady: true })).toEqual([]);
  });

  it("sin Kushki activo no hay ningún medio en línea", () => {
    expect(defaultOnlineMethod({ applePayAvailable: true, enabledMethods: ALL, kushkiReady: false })).toBeNull();
    expect(onlineMethodsInOrder({ applePayAvailable: true, enabledMethods: ALL, kushkiReady: false })).toEqual([]);
  });
});
