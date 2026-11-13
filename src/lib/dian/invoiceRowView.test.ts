// Cómo se presenta cada fila de /operator/facturas: semáforo, motivo en una
// línea, estado del correo, qué acción va a la vista y cuáles al menú «⋯».
import { describe, expect, it } from "vitest";
import type { InvoiceDianStatus } from "./invoiceList";
import {
  adviceCauseKey,
  canRetryEmission,
  invoiceActionPlan,
  invoiceEmailStatus,
  invoicePageRange,
  invoiceStatusTone,
  parseDianReason,
} from "./invoiceRowView";

describe("invoiceStatusTone: el semáforo del estado DIAN", () => {
  it.each<[InvoiceDianStatus, string | null, string]>([
    ["accepted", null, "ok"],
    ["rejected", "Regla: FAK24, Rechazo: x", "critical"],
    ["error_stuck", "timeout", "critical"],
    ["error_retrying", "timeout", "warning"],
    ["not_sent", "resolution_incomplete", "warning"],
    ["not_sent", null, "info"],
    ["in_process", null, "info"],
  ])("%s (motivo %s) → %s", (status, reason, tone) => {
    expect(invoiceStatusTone(status, reason)).toBe(tone);
  });
});

describe("parseDianReason: el motivo, desarmado para una línea", () => {
  it("una regla de la DIAN: el código aparte y la frase sola", () => {
    expect(
      parseDianReason("Regla: FAK24, Rechazo: No está informado el DV del NIT del adquiriente"),
    ).toEqual({ kind: "rule", rule: "FAK24", text: "No está informado el DV del NIT del adquiriente" });
  });

  it("acepta variantes de la DIAN (Notificación, tilde rota, minúsculas, espacios de más)", () => {
    expect(parseDianReason("Regla: faj43b, Notificación: Nombre informado no corresponde")).toEqual({
      kind: "rule",
      rule: "FAJ43B",
      text: "Nombre informado no corresponde",
    });
    expect(parseDianReason("Regla: RUT01, Notificaci\uFFFDn: estado del RUT")).toEqual({
      kind: "rule",
      rule: "RUT01",
      text: "estado del RUT",
    });
    expect(parseDianReason("  Regla: 90, Rechazo:   Documento   procesado anteriormente. ")).toEqual({
      kind: "rule",
      rule: "90",
      text: "Documento procesado anteriormente.",
    });
  });

  it("un código de configuración del comercio queda como código (lo traduce la pantalla)", () => {
    expect(parseDianReason("resolution_incomplete")).toEqual({ kind: "config", code: "resolution_incomplete" });
    expect(parseDianReason("numbering_exhausted")).toEqual({ kind: "config", code: "numbering_exhausted" });
    // Los de #585: la consulta del envío anterior y la regla 90 sin confirmar.
    expect(parseDianReason("dian_status_unavailable")).toEqual({ kind: "config", code: "dian_status_unavailable" });
    expect(parseDianReason("dian_duplicate_unverified")).toEqual({
      kind: "config",
      code: "dian_duplicate_unverified",
    });
  });

  it("cualquier otro texto (falla de canal, SOAP Fault) pasa tal cual, en una línea", () => {
    expect(parseDianReason("a:InvalidSecurity:\n  An error occurred")).toEqual({
      kind: "text",
      text: "a:InvalidSecurity: An error occurred",
    });
  });

  it("sin motivo no hay nada que mostrar", () => {
    expect(parseDianReason(null)).toBeNull();
    expect(parseDianReason("   ")).toBeNull();
  });

  it("una regla sin frase conserva el texto completo", () => {
    expect(parseDianReason("Regla: FAU14, Rechazo:")).toEqual({
      kind: "rule",
      rule: "FAU14",
      text: "Regla: FAU14, Rechazo:",
    });
  });
});

describe("invoiceEmailStatus: el chip del correo", () => {
  const base = { emailedAt: null, emailError: null, emailTo: "ana@correo.com" } as const;
  it("antes de que la DIAN la acepte, el correo no aplica", () => {
    expect(invoiceEmailStatus({ ...base, status: "rejected" })).toBe("not_applicable");
    expect(invoiceEmailStatus({ ...base, status: "in_process", emailedAt: "2026-10-30T18:05:03.000Z" })).toBe(
      "not_applicable",
    );
  });
  it("aceptada: enviado, sin correo, falló o todavía no", () => {
    expect(invoiceEmailStatus({ ...base, status: "accepted", emailedAt: "2026-10-30T18:05:03.000Z" })).toBe("sent");
    expect(invoiceEmailStatus({ ...base, status: "accepted", emailTo: null })).toBe("no_recipient");
    expect(invoiceEmailStatus({ ...base, status: "accepted", emailError: "no_recipient" })).toBe("no_recipient");
    expect(invoiceEmailStatus({ ...base, status: "accepted", emailError: "send_failed" })).toBe("failed");
    expect(invoiceEmailStatus({ ...base, status: "accepted" })).toBe("pending");
  });
});

describe("invoiceActionPlan: UNA acción a la vista, el resto en «⋯»", () => {
  const plan = (status: InvoiceDianStatus, reason: string | null = null, emailError: string | null = null) =>
    invoiceActionPlan({ status, reason, emailError });

  it("aceptada: Reimprimir a la vista; reenviar y anular con nota crédito en el menú (anular al final)", () => {
    expect(plan("accepted")).toEqual({ primary: "reprint", menu: ["view", "resend", "order", "creditNote"] });
  });

  it("aceptada con el correo fallido: Reenviar a la vista", () => {
    expect(plan("accepted", null, "send_failed")).toEqual({
      primary: "resend",
      menu: ["view", "reprint", "order", "creditNote"],
    });
  });

  it("rechazada: Reintentar a la vista; nunca reenviar ni anular (no es fiscal)", () => {
    const p = plan("rejected", "Regla: FAK24, Rechazo: x");
    expect(p).toEqual({ primary: "retry", menu: ["view", "reprint", "order"] });
    expect(p.menu).not.toContain("creditNote");
    expect(p.menu).not.toContain("resend");
  });

  it("reintentos agotados y frenada por configuración: Reintentar a la vista", () => {
    expect(plan("error_stuck", "timeout").primary).toBe("retry");
    expect(plan("not_sent", "resolution_incomplete").primary).toBe("retry");
  });

  it("lo que se resuelve solo muestra Ver factura; el reintento manual del error queda en el menú", () => {
    expect(plan("error_retrying", "timeout")).toEqual({ primary: "view", menu: ["reprint", "retry", "order"] });
    expect(plan("in_process")).toEqual({ primary: "view", menu: ["reprint", "order"] });
    expect(plan("not_sent")).toEqual({ primary: "view", menu: ["reprint", "order"] });
  });

  it("causa conocida de la DIAN: la recomendada es la principal y reemplaza a Reintentar", () => {
    expect(invoiceActionPlan({ status: "rejected", reason: "Regla: FAW01, Rechazo: x", emailError: null, recovery: "resend" })).toEqual({
      primary: "recover",
      menu: ["view", "reprint", "order"],
    });
    expect(invoiceActionPlan({ status: "rejected", reason: "Regla: 90, Rechazo: x", emailError: null, recovery: "check_status" }).primary).toBe(
      "recover",
    );
    // La regla 90 sin confirmar (en proceso) también se consulta desde la fila.
    expect(
      invoiceActionPlan({ status: "in_process", reason: null, emailError: null, recovery: "check_status" }),
    ).toEqual({ primary: "recover", menu: ["view", "reprint", "order"] });
    // Una falla de la DIAN que ya agotó reintentos: se reenvía, no se reintenta.
    expect(invoiceActionPlan({ status: "error_stuck", reason: "x", emailError: null, recovery: "resend" }).menu).not.toContain("retry");
  });

  it("sin acción recomendada («other» / none) queda el Reintentar de siempre", () => {
    expect(invoiceActionPlan({ status: "rejected", reason: "Regla: FAK24, Rechazo: x", emailError: null, recovery: "none" }).primary).toBe(
      "retry",
    );
    expect(invoiceActionPlan({ status: "rejected", reason: "x", emailError: null, recovery: null }).primary).toBe("retry");
    // Aceptada nunca se recupera, aunque llegue una recomendación vieja.
    expect(invoiceActionPlan({ status: "accepted", reason: null, emailError: null, recovery: "resend" }).primary).toBe("reprint");
  });

  it("la principal nunca se repite en el menú", () => {
    const statuses: InvoiceDianStatus[] = ["accepted", "rejected", "error_retrying", "error_stuck", "in_process", "not_sent"];
    for (const s of statuses) {
      for (const reason of [null, "timeout"]) {
        const p = plan(s, reason);
        expect(p.menu).not.toContain(p.primary);
      }
    }
  });
});

describe("adviceCauseKey: el texto claro de la causa", () => {
  it("la causa conocida da su clave; la regla 90 en proceso es «sin confirmar»", () => {
    expect(adviceCauseKey({ cause: "zero_value_line" }, "rejected")).toBe("zero_value_line");
    expect(adviceCauseKey({ cause: "already_at_dian" }, "rejected")).toBe("already_at_dian");
    expect(adviceCauseKey({ cause: "already_at_dian" }, "in_process")).toBe("unverified");
    expect(adviceCauseKey({ cause: "dian_transient" }, "error_stuck")).toBe("dian_transient");
  });
  it("«other» o sin recomendación: el motivo de siempre", () => {
    expect(adviceCauseKey({ cause: "other" }, "rejected")).toBeNull();
    expect(adviceCauseKey(null, "rejected")).toBeNull();
    expect(adviceCauseKey(undefined, "accepted")).toBeNull();
  });
});

describe("canRetryEmission: el reintento de siempre", () => {
  it("rechazada, con error o frenada sí; en cola sin motivo, en la DIAN o aceptada no", () => {
    expect(canRetryEmission("rejected", null)).toBe(true);
    expect(canRetryEmission("error_retrying", "timeout")).toBe(true);
    expect(canRetryEmission("error_stuck", "timeout")).toBe(true);
    expect(canRetryEmission("not_sent", "resolution_incomplete")).toBe(true);
    expect(canRetryEmission("not_sent", null)).toBe(false);
    expect(canRetryEmission("in_process", null)).toBe(false);
    expect(canRetryEmission("accepted", null)).toBe(false);
  });
});

describe("invoicePageRange: «Mostrando X–Y de N»", () => {
  it("primera, del medio y última página (incompleta)", () => {
    expect(invoicePageRange(1, 50, 50)).toEqual({ from: 1, to: 50 });
    expect(invoicePageRange(2, 50, 50)).toEqual({ from: 51, to: 100 });
    expect(invoicePageRange(3, 7, 50)).toEqual({ from: 101, to: 107 });
  });
  it("página vacía (filtro sin resultados o página fuera de rango)", () => {
    expect(invoicePageRange(1, 0, 50)).toEqual({ from: 0, to: 0 });
    expect(invoicePageRange(9, 0, 50)).toEqual({ from: 0, to: 0 });
  });
});
