// Cómo se clasifica un fallo de Kushki al activar el débito automático o
// cambiar la tarjeta. Funciones puras: nunca llama a Kushki.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: {}, requireKushkiKey: () => "test" }));
vi.mock("@/lib/platformConfig", () => ({ getKushkiModeSync: () => "production" }));

import { KushkiHttpError, KushkiSchemaError } from "@/lib/payments/kushki/client";
import { classifySubscriptionError, isSubscriptionNotFound, subscriptionErrorHttpStatus } from "./subscriptionErrors";

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

  it("K012 (id de suscripción no válida) → not_found con la referencia", () => {
    // El caso real de producción: suscripción creada en sandbox, cuenta de cobro hoy en producción.
    const err = kushki(400, '{"code":"K012","message":"ID de suscripción no válida."}');
    expect(classifySubscriptionError(err)).toEqual({ reason: "not_found", providerCode: "K012" });
  });

  it("404 sin código → not_found", () => {
    expect(classifySubscriptionError(kushki(404, "Not Found"))).toEqual({ reason: "not_found", providerCode: null });
  });

  it("el code se normaliza (espacios, minúsculas) antes de buscarlo en la tabla", () => {
    expect(classifySubscriptionError(kushki(400, '{"code":" k322 "}'))).toEqual({
      reason: "security_rejected",
      providerCode: "K322",
    });
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

describe("isSubscriptionNotFound", () => {
  it("K012 o HTTP 404 → true, sea KushkiHttpError o un objeto {status, body} cualquiera", () => {
    expect(isSubscriptionNotFound(kushki(400, '{"code":"K012","message":"ID de suscripción no válida."}'))).toBe(true);
    expect(isSubscriptionNotFound(kushki(404, "<html>Not Found</html>"))).toBe(true);
    // Robusto: minúsculas, espacios, y sin instanceof.
    expect(isSubscriptionNotFound({ status: 400, body: '{"code":" k012 "}' })).toBe(true);
    expect(isSubscriptionNotFound(Object.assign(new Error("x"), { status: 404, body: "" }))).toBe(true);
  });

  it("cualquier otro error → false (nunca se da por cancelada por un fallo distinto)", () => {
    // K004 con un mensaje que habla de "not found" NO cuenta: se va por el código, no por el texto.
    expect(isSubscriptionNotFound(kushki(400, '{"code":"K004","message":"Subscription not found"}'))).toBe(false);
    expect(isSubscriptionNotFound(kushki(400, '{"code":"K001"}'))).toBe(false);
    expect(isSubscriptionNotFound(kushki(401, '{"message":"Unauthorized"}'))).toBe(false);
    expect(isSubscriptionNotFound(kushki(500, "boom"))).toBe(false);
    expect(isSubscriptionNotFound(kushki(400, "<html>Bad Request</html>"))).toBe(false);
    expect(isSubscriptionNotFound(new Error("billing_not_configured: falta la clave"))).toBe(false);
    expect(isSubscriptionNotFound(new TypeError("fetch failed"))).toBe(false);
    expect(isSubscriptionNotFound(null)).toBe(false);
    expect(isSubscriptionNotFound("raro")).toBe(false);
    expect(isSubscriptionNotFound({ status: "404" })).toBe(false);
  });
});

describe("subscriptionErrorHttpStatus", () => {
  it("402 del lado de la tarjeta, 500 si es nuestro, 502 si no se sabe (not_found incluido)", () => {
    expect(subscriptionErrorHttpStatus("security_rejected")).toBe(402);
    expect(subscriptionErrorHttpStatus("card_declined")).toBe(402);
    expect(subscriptionErrorHttpStatus("card_invalid")).toBe(402);
    expect(subscriptionErrorHttpStatus("not_configured")).toBe(500);
    expect(subscriptionErrorHttpStatus("unavailable")).toBe(502);
    expect(subscriptionErrorHttpStatus("unknown")).toBe(502);
    expect(subscriptionErrorHttpStatus("not_found")).toBe(502);
  });
});
