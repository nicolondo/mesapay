// Cómo se clasifica lo que lanza `chargeWithToken` (tarjeta / Apple Pay):
// rechazo definitivo de Kushki vs. resultado incierto. Funciones puras:
// nunca se llama a Kushki.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: {}, requireKushkiKey: () => "test" }));
vi.mock("@/lib/platformConfig", () => ({ getKushkiModeSync: () => "production" }));

import { KushkiHttpError, KushkiSchemaError } from "./client";
import { chargeFailureLogFields, classifyKushkiChargeError } from "./chargeError";

const URL = "https://api.kushkipagos.com/card/v1/charges";
const kushki = (status: number, body: unknown) =>
  new KushkiHttpError(status, typeof body === "string" ? body : JSON.stringify(body), URL);

describe("classifyKushkiChargeError: rechazo definitivo", () => {
  it("K322 (antifraude, «Transacción rechazada») → rechazo, nunca incierto", () => {
    // El caso real de producción: Apple Pay desde la mesa.
    expect(classifyKushkiChargeError(kushki(400, { code: "K322", message: "Transacción rechazada." }))).toEqual({
      outcome: "declined",
      reason: "security_rejected",
      httpStatus: 400,
      code: "K322",
      message: "Transacción rechazada.",
      errorName: "KushkiHttpError",
    });
  });

  it.each([400, 402, 403, 422])("K322 con HTTP %i también es rechazo", (status) => {
    expect(classifyKushkiChargeError(kushki(status, { code: "K322", message: "Transacción rechazada." }))).toMatchObject({
      outcome: "declined",
      reason: "security_rejected",
    });
  });

  it("un código definitivo gana aunque su mensaje pida reintentar", () => {
    const failure = classifyKushkiChargeError(kushki(400, { code: "K322", message: "Transacción rechazada. Intente de nuevo." }));
    expect(failure).toMatchObject({ outcome: "declined", reason: "security_rejected" });
  });

  it("el código se normaliza (espacios, minúsculas, número)", () => {
    expect(classifyKushkiChargeError(kushki(400, { code: " k322 " }))).toMatchObject({ outcome: "declined", code: "K322" });
    expect(classifyKushkiChargeError(kushki(400, { code: 21, message: "Fondos insuficientes" }))).toMatchObject({
      outcome: "declined",
      reason: "card_funds",
      code: "021",
    });
  });

  it.each([
    ["022", "card_cvv"],
    ["021", "card_funds"],
    ["017", "card_invalid"],
    ["023", "card_blocked"],
    ["K040", "merchant_config"],
  ])("código %s → %s", (code, reason) => {
    expect(classifyKushkiChargeError(kushki(400, { code, message: "x" }))).toMatchObject({ outcome: "declined", reason, code });
  });

  it("código de Kushki no mapeado → rechazo con motivo genérico, conserva el código", () => {
    expect(classifyKushkiChargeError(kushki(400, { code: "K220", message: "Monto de la transacción es diferente al monto de la venta inicial" }))).toMatchObject({
      outcome: "declined",
      reason: "charge_failed",
      code: "K220",
    });
  });

  it("401 / 403 de credenciales (sólo `message`) → rechazo por configuración del comercio", () => {
    expect(classifyKushkiChargeError(kushki(401, { message: "Unauthorized" }))).toMatchObject({
      outcome: "declined",
      reason: "merchant_config",
      code: null,
    });
    expect(classifyKushkiChargeError(kushki(403, { message: "Forbidden" }))).toMatchObject({ outcome: "declined", reason: "merchant_config" });
  });
});

describe("classifyKushkiChargeError: incierto (el cargo pudo haberse procesado)", () => {
  it.each([500, 502, 503, 504])("HTTP %i → incierto aunque el cuerpo traiga un código", (status) => {
    expect(classifyKushkiChargeError(kushki(status, { code: "K322", message: "Transacción rechazada." }))).toMatchObject({
      outcome: "uncertain",
      cause: "http_5xx",
      httpStatus: status,
    });
  });

  it.each([408, 409, 425, 429])("HTTP %i (ambiguo) → incierto", (status) => {
    expect(classifyKushkiChargeError(kushki(status, { code: "K322", message: "Transacción rechazada." }))).toMatchObject({
      outcome: "uncertain",
      cause: "http_ambiguous",
      httpStatus: status,
    });
  });

  it("timeout y aborto → incierto", () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(classifyKushkiChargeError(timeout)).toMatchObject({ outcome: "uncertain", cause: "timeout", errorName: "TimeoutError" });
    expect(classifyKushkiChargeError(abort)).toMatchObject({ outcome: "uncertain", cause: "timeout", errorName: "AbortError" });
  });

  it("error de red → incierto", () => {
    expect(classifyKushkiChargeError(new TypeError("fetch failed"))).toMatchObject({
      outcome: "uncertain",
      cause: "network",
      httpStatus: null,
      code: null,
      errorName: "TypeError",
    });
  });

  it("2xx que no parsea (KushkiSchemaError): Kushki SÍ respondió con éxito → incierto", () => {
    expect(classifyKushkiChargeError(new KushkiSchemaError(URL, "schema mismatch", "{}"))).toMatchObject({
      outcome: "uncertain",
      cause: "schema",
      errorName: "KushkiSchemaError",
    });
  });

  it.each([
    ["577", "Token de la transacción no válido"],
    ["K049", "Token ya utilizado"],
  ])("token ya usado (%s) → incierto: un intento previo pudo haber cobrado", (code, message) => {
    expect(classifyKushkiChargeError(kushki(400, { code, message }))).toMatchObject({
      outcome: "uncertain",
      cause: "token_reuse",
      httpStatus: 400,
      code,
    });
  });

  it("código desconocido cuyo mensaje nombra el token → incierto", () => {
    expect(classifyKushkiChargeError(kushki(400, { code: "K999", message: "El token ya fue utilizado" }))).toMatchObject({
      outcome: "uncertain",
      cause: "token_reuse",
    });
    expect(classifyKushkiChargeError(kushki(403, { message: "Missing Authentication Token" }))).toMatchObject({ outcome: "uncertain" });
  });

  it.each(["K003", "K027", "K035", "K046"])("fallo transitorio del gateway/procesador (%s) → incierto", (code) => {
    expect(classifyKushkiChargeError(kushki(400, { code, message: "x" }))).toMatchObject({
      outcome: "uncertain",
      cause: "processor_unavailable",
      code,
    });
  });

  it("processorError transitorio manda sobre un code definitivo", () => {
    expect(classifyKushkiChargeError(kushki(400, { code: "K322", message: "x", processorError: "591" }))).toMatchObject({
      outcome: "uncertain",
      cause: "processor_unavailable",
    });
  });

  it.each([
    "Tiempo de espera agotado",
    "Request timed out",
    "Ha ocurrido un error inesperado",
    "Procesador inalcanzable",
    "Servicio no disponible",
    "Transacción duplicada",
    "Transacción en proceso",
  ])("código desconocido con mensaje ambiguo («%s») → incierto", (message) => {
    expect(classifyKushkiChargeError(kushki(400, { code: "K998", message }))).toMatchObject({ outcome: "uncertain" });
  });

  it.each([
    ["HTML de un proxy", "<html>Bad Request</html>"],
    ["cuerpo vacío", ""],
    ["JSON que no es objeto", "[1,2]"],
    ["JSON sin code ni message", '{"foo":"bar"}'],
  ])("4xx con cuerpo no reconocible (%s) → incierto", (_label, body) => {
    expect(classifyKushkiChargeError(kushki(400, body))).toMatchObject({
      outcome: "uncertain",
      cause: "unrecognized_body",
      httpStatus: 400,
    });
  });

  it("cualquier otra excepción → incierto", () => {
    expect(classifyKushkiChargeError(new Error("boom"))).toMatchObject({ outcome: "uncertain", cause: "unknown", errorName: "Error" });
    expect(classifyKushkiChargeError("no es un Error")).toMatchObject({ outcome: "uncertain", cause: "unknown", errorName: "unknown" });
    expect(classifyKushkiChargeError(null)).toMatchObject({ outcome: "uncertain", cause: "unknown" });
  });

  it("un status que no es 4xx ni 5xx (redirección) → incierto", () => {
    expect(classifyKushkiChargeError(kushki(302, { code: "K322" }))).toMatchObject({ outcome: "uncertain", cause: "http_status" });
  });
});

describe("chargeFailureLogFields", () => {
  it("lleva status, código y el nombre real del error; nunca el cuerpo ni el mensaje", () => {
    const body = { code: "K322", message: "Transacción rechazada.", details: { cardHolderName: "TITULAR", lastFourDigits: "4242" }, token: "tok-secreto" };
    const fields = chargeFailureLogFields(classifyKushkiChargeError(kushki(400, body)));
    expect(fields).toEqual({ outcome: "declined", reason: "security_rejected", status: 400, code: "K322", name: "KushkiHttpError" });
    expect(JSON.stringify(fields)).not.toMatch(/TITULAR|4242|tok-secreto|rechazada/);
  });

  it("incierto: causa, status (si hubo) y nombre", () => {
    expect(chargeFailureLogFields(classifyKushkiChargeError(kushki(503, "Service Unavailable")))).toEqual({
      outcome: "uncertain",
      cause: "http_5xx",
      status: 503,
      code: null,
      name: "KushkiHttpError",
    });
    expect(chargeFailureLogFields(classifyKushkiChargeError(new TypeError("fetch failed")))).toEqual({
      outcome: "uncertain",
      cause: "network",
      status: null,
      code: null,
      name: "TypeError",
    });
  });
});
