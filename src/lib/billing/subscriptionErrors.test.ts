// Cómo se clasifica un fallo de Kushki al activar el débito automático o
// cambiar la tarjeta. Funciones puras: nunca llama a Kushki.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: {}, requireKushkiKey: () => "test" }));
vi.mock("@/lib/platformConfig", () => ({ getKushkiModeSync: () => "production" }));

import { KushkiHttpError, KushkiSchemaError } from "@/lib/payments/kushki/client";
import { classifySubscriptionError, subscriptionErrorHttpStatus } from "./subscriptionErrors";

const URL = "https://api.kushkipagos.com/subscriptions/v1/card";
const kushki = (status: number, body: string) => new KushkiHttpError(status, body, URL);

describe("classifySubscriptionError", () => {
  it("K322 (regla de seguridad de Kushki) → security_rejected con la referencia", () => {
    // El caso real de producción (Son y Melona).
    const err = kushki(400, '{"code":"K322","message":"Transacción rechazada."}');
    expect(classifySubscriptionError(err)).toEqual({
      reason: "security_rejected",
      providerCode: "K322",
    });
  });

  it("rechazo del emisor (K007) → card_declined", () => {
    const err = kushki(400, '{"code":"K007","message":"Tarjeta bloqueada por el emisor"}');
    expect(classifySubscriptionError(err)).toEqual({ reason: "card_declined", providerCode: "K007" });
  });

  it("processorError manda sobre el code genérico", () => {
    // K006 = rechazo por cobro de validación; 514 = número de tarjeta inválido.
    const err = kushki(400, '{"code":"K006","message":"x","processorError":"514"}');
    expect(classifySubscriptionError(err)).toEqual({ reason: "card_invalid", providerCode: "K006" });
  });

  it("tarjeta expirada (K049) → card_invalid", () => {
    const err = kushki(400, '{"code":"K049","message":"Tarjeta expirada"}');
    expect(classifySubscriptionError(err).reason).toBe("card_invalid");
  });

  it("comercio no habilitado para suscripciones (K010) → not_configured", () => {
    const err = kushki(400, '{"code":"K010","message":"Comercio no habilitado para suscripciones"}');
    expect(classifySubscriptionError(err)).toEqual({ reason: "not_configured", providerCode: "K010" });
  });

  it("código no mapeado → unknown, pero conserva la referencia", () => {
    const err = kushki(400, '{"code":"K999","message":"??"}');
    expect(classifySubscriptionError(err)).toEqual({ reason: "unknown", providerCode: "K999" });
  });

  it("body no-JSON → sin referencia", () => {
    expect(classifySubscriptionError(kushki(400, "<html>Bad Request</html>"))).toEqual({
      reason: "unknown",
      providerCode: null,
    });
  });

  it("5xx sin código → unavailable", () => {
    expect(classifySubscriptionError(kushki(503, "Service Unavailable"))).toEqual({
      reason: "unavailable",
      providerCode: null,
    });
  });

  it("401 (credenciales nuestras) → not_configured", () => {
    expect(classifySubscriptionError(kushki(401, '{"message":"Unauthorized"}')).reason).toBe(
      "not_configured",
    );
  });

  it("falta la clave de cobro (billing_not_configured) → not_configured", () => {
    const err = new Error("billing_not_configured: falta la clave privada de cobro");
    expect(classifySubscriptionError(err)).toEqual({ reason: "not_configured", providerCode: null });
  });

  it("timeout y red caída → unavailable", () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    expect(classifySubscriptionError(timeout).reason).toBe("unavailable");
    expect(classifySubscriptionError(new TypeError("fetch failed")).reason).toBe("unavailable");
  });

  it("un Error cualquiera (no de Kushki) → unknown", () => {
    expect(classifySubscriptionError(new Error("boom"))).toEqual({ reason: "unknown", providerCode: null });
    expect(classifySubscriptionError("no es un Error")).toEqual({ reason: "unknown", providerCode: null });
  });

  it("2xx con forma inesperada (KushkiSchemaError) → unknown", () => {
    const err = new KushkiSchemaError(URL, "schema mismatch", "{}");
    expect(classifySubscriptionError(err)).toEqual({ reason: "unknown", providerCode: null });
  });
});

describe("subscriptionErrorHttpStatus", () => {
  it("402 del lado de la tarjeta, 500 si es nuestro, 502 si no se sabe", () => {
    expect(subscriptionErrorHttpStatus("security_rejected")).toBe(402);
    expect(subscriptionErrorHttpStatus("card_declined")).toBe(402);
    expect(subscriptionErrorHttpStatus("card_invalid")).toBe(402);
    expect(subscriptionErrorHttpStatus("not_configured")).toBe(500);
    expect(subscriptionErrorHttpStatus("unavailable")).toBe(502);
    expect(subscriptionErrorHttpStatus("unknown")).toBe(502);
  });
});
