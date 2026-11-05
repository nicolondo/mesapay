// Qué hace con una factura cada respuesta de la DIAN. Los textos son los
// que devolvió la DIAN en producción (sin datos de comercio): FAW01, la
// regla 90, la notificación RUT01 y el RUT01 con la plantilla sin armar.
import { describe, expect, it } from "vitest";
import {
  classifyInvoiceResponse,
  dianRecoveryAdvice,
  dianRejectionCause,
  DUPLICATE_UNVERIFIED,
  isCufe,
  parseDianMessage,
  recoveryActionFor,
} from "./invoiceResponse";
import { parseDianResponse } from "./soap";

const FAW01 =
  "Regla: FAW01, Rechazo: Línea de factura informado con LineExtensionAmount en cero y grupo cac:PricingReference no informado";
const RULE_90 = "Regla: 90, Rechazo: Documento procesado anteriormente.";
const RUT01_NOTICE = "Regla: RUT01, Notificación: La validación del estado del RUT próximamente estará disponible.";
const RUT01_GLITCH =
  "Regla: RUT01, Rechazo: Señor usuario en este momento el estado de su RUT es {StatusRut}, por favor agende una cita";
// El mismo, tal como quedó guardado con la tilde rota antes de decodificar bien.
const RUT01_GLITCH_MOJIBAKE =
  "Regla: RUT01, Rechazo: Se�or usuario en este momento el estado de su RUT es {StatusRut}, por favor agende una cita";
const FAJ50_NOTICE = "Regla: FAJ50, Notificación: El prefijo debe corresponder  al código de la sucursal";
const FAB10A = "Regla: FAB10a, Rechazo: El prefijo de numeración no es igual al código de la sucursal";

const rejected = (errors: string[], statusCode = "99") => ({ state: "rejected" as const, statusCode, errors });

describe("parseDianMessage", () => {
  it("distingue Rechazo de Notificación y saca el código de la regla", () => {
    expect(parseDianMessage(FAW01)).toMatchObject({ rule: "FAW01", kind: "rejection" });
    expect(parseDianMessage(RUT01_NOTICE)).toMatchObject({ rule: "RUT01", kind: "notification" });
    expect(parseDianMessage(RULE_90)).toMatchObject({ rule: "90", kind: "rejection", text: "Documento procesado anteriormente." });
  });

  it("una notificación guardada con la tilde rota sigue siendo notificación", () => {
    expect(parseDianMessage("Regla: RUT01, Notificaci�n: x").kind).toBe("notification");
  });

  it("un texto sin el formato de regla cuenta como rechazo (lo conservador)", () => {
    expect(parseDianMessage("FAJ71")).toMatchObject({ rule: null, kind: "rejection" });
  });
});

describe("classifyInvoiceResponse", () => {
  it("aceptada con notificaciones: aceptada, y las notificaciones quedan como advertencias", () => {
    expect(classifyInvoiceResponse({ state: "accepted", errors: [FAJ50_NOTICE] })).toEqual({
      kind: "accepted",
      warnings: [FAJ50_NOTICE],
    });
  });

  it("IsValid=false con SÓLO notificaciones no es un rechazo: se reintenta", () => {
    expect(classifyInvoiceResponse(rejected([RUT01_NOTICE]))).toMatchObject({
      kind: "transient",
      reason: "notification_only",
      warnings: [RUT01_NOTICE],
    });
  });

  it("un rechazo real con notificaciones al lado sigue siendo rechazo", () => {
    expect(classifyInvoiceResponse(rejected([FAB10A, FAJ50_NOTICE])).kind).toBe("rejected");
    expect(classifyInvoiceResponse(rejected([FAW01])).kind).toBe("rejected");
  });

  it("regla 90 ⇒ duplicate (hay que consultar por CUFE, nunca rechazada)", () => {
    expect(classifyInvoiceResponse(rejected([RULE_90])).kind).toBe("duplicate");
    expect(classifyInvoiceResponse(rejected([RULE_90, RUT01_NOTICE])).kind).toBe("duplicate");
  });

  it("la plantilla de la DIAN sin armar ({StatusRut}) ⇒ transitoria, también con la tilde rota", () => {
    expect(classifyInvoiceResponse(rejected([RUT01_GLITCH]))).toMatchObject({ kind: "transient", reason: "platform_glitch" });
    expect(classifyInvoiceResponse(rejected([RUT01_GLITCH_MOJIBAKE])).kind).toBe("transient");
  });

  it("plantilla sin armar MÁS un rechazo real ⇒ rechazada (hay algo que corregir)", () => {
    expect(classifyInvoiceResponse(rejected([RUT01_GLITCH, FAW01])).kind).toBe("rejected");
  });

  it("StatusCode 66/90 de GetStatus sin reglas ⇒ no encontrada (no es la regla 90)", () => {
    expect(classifyInvoiceResponse(rejected([], "66")).kind).toBe("not_found");
    expect(classifyInvoiceResponse(rejected([], "90")).kind).toBe("not_found");
  });

  it("canal y pendiente pasan tal cual", () => {
    expect(classifyInvoiceResponse({ state: "error", errors: ["timeout"] }).kind).toBe("channel_error");
    expect(classifyInvoiceResponse({ state: "pending", errors: [] }).kind).toBe("pending");
  });

  it("con la respuesta SOAP real: la regla 90 llega como rechazo 99 y se clasifica duplicate", () => {
    const raw =
      `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><SendBillSyncResponse xmlns="http://wcf.dian.colombia">` +
      `<SendBillSyncResult xmlns:b="http://schemas.datacontract.org/2004/07/DianResponse"><b:ErrorMessage xmlns:c="http://schemas.microsoft.com/2003/10/Serialization/Arrays">` +
      `<c:string>${RULE_90}</c:string></b:ErrorMessage><b:IsValid>false</b:IsValid><b:StatusCode>99</b:StatusCode>` +
      `<b:XmlDocumentKey>${"a".repeat(96)}</b:XmlDocumentKey></SendBillSyncResult></SendBillSyncResponse></s:Body></s:Envelope>`;
    const parsed = parseDianResponse(raw);
    expect(parsed.state).toBe("rejected");
    expect(classifyInvoiceResponse(parsed).kind).toBe("duplicate");
  });
});

describe("dianRejectionCause / recoveryActionFor (lo que ve el operador)", () => {
  it("FAW01 ⇒ producto en $0 ⇒ reenviar", () => {
    const cause = dianRejectionCause({ errors: [FAW01, FAW01] });
    expect(cause).toBe("zero_value_line");
    expect(recoveryActionFor(cause)).toBe("resend");
  });

  it("regla 90 ⇒ la DIAN ya la tiene ⇒ consultar", () => {
    const cause = dianRejectionCause({ errors: [RULE_90] });
    expect(cause).toBe("already_at_dian");
    expect(recoveryActionFor(cause)).toBe("check_status");
    expect(dianRejectionCause({ lastError: DUPLICATE_UNVERIFIED, errors: [] })).toBe("already_at_dian");
  });

  it("sólo la notificación RUT01 ⇒ reenviar", () => {
    expect(dianRejectionCause({ errors: [RUT01_NOTICE] })).toBe("dian_notification");
    expect(recoveryActionFor("dian_notification")).toBe("resend");
  });

  it("RUT01 con {StatusRut} ⇒ falla de la DIAN ⇒ reenviar", () => {
    expect(dianRejectionCause({ errors: [RUT01_GLITCH_MOJIBAKE] })).toBe("dian_transient");
    expect(recoveryActionFor("dian_transient")).toBe("resend");
  });

  it("FAW01 con otro rechazo real ⇒ otro (hay que corregir primero, nada automático)", () => {
    expect(dianRejectionCause({ errors: [FAW01, FAB10A] })).toBe("other");
    expect(recoveryActionFor("other")).toBe("none");
  });

  it("dianRecoveryAdvice: sólo para rechazadas, errores con causa DIAN y sin confirmar", () => {
    expect(dianRecoveryAdvice({ state: "rejected", errors: [FAW01] })).toEqual({ cause: "zero_value_line", action: "resend" });
    expect(dianRecoveryAdvice({ state: "pending", lastError: DUPLICATE_UNVERIFIED, errors: [RULE_90] })).toEqual({
      cause: "already_at_dian",
      action: "check_status",
    });
    expect(dianRecoveryAdvice({ state: "error", errors: [RUT01_NOTICE] })).toEqual({ cause: "dian_notification", action: "resend" });
    // Un timeout no es una causa nueva: lo resuelve el reintento de siempre.
    expect(dianRecoveryAdvice({ state: "error", errors: ["timeout"] })).toBeNull();
    expect(dianRecoveryAdvice({ state: "accepted", errors: [] })).toBeNull();
    expect(dianRecoveryAdvice({ state: "pending", errors: [] })).toBeNull();
    // Un rechazo real: causa "other", sin acción nueva (queda «Reintentar emisión»).
    expect(dianRecoveryAdvice({ state: "rejected", errors: [FAB10A] })).toEqual({ cause: "other", action: "none" });
  });

  it("isCufe", () => {
    expect(isCufe("a".repeat(96))).toBe(true);
    expect(isCufe("A".repeat(96))).toBe(true);
    expect(isCufe("CUFE-DIAN")).toBe(false);
    expect(isCufe(null)).toBe(false);
  });
});
