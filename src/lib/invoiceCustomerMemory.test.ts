import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decideMemoryAction,
  editableBySelfService,
  hashLookupToken,
  invoiceSummaryFor,
  maskEmail,
  maskName,
  orderAcceptsLookup,
  pickBestCustomer,
  signLookupToken,
  verifyLookupToken,
  type ExistingCustomer,
} from "./invoiceCustomerMemory";

// Datos inventados: ninguna cédula, nombre ni correo real.

describe("enmascarado: el comensal reconoce sus datos sin ver los de otro", () => {
  it.each([
    ["Juana Gómez Ruiz", "Ju••• G. R."],
    ["ana", "an•••"],
    ["Al Pérez", "A••• P."],
    ["  Comercializadora   ABC  S.A.S. ", "Co••• A. S."],
    ["Uno Dos Tres Cuatro Cinco", "Un••• D. T. C."],
    ["", "•••"],
  ])("%s → %s", (name, masked) => {
    expect(maskName(name)).toBe(masked);
  });

  it.each([
    ["juana.gomez@gmail.com", "ju***@gm***.com"],
    ["ana@empresa.com.co", "an***@em***.com.co"],
    ["a@b.co", "a***@b***.co"],
    ["facturas@mail.empresa.com", "fa***@em***.com"],
    ["raro@localhost", "ra***@***"],
    ["sin-arroba", "***"],
  ])("%s → %s", (email, masked) => {
    expect(maskEmail(email)).toBe(masked);
  });

  it("el resumen enmascarado no lleva el nombre ni los correos completos", () => {
    const row = {
      status: "pending" as const,
      customerName: "Juana Gómez Ruiz",
      docType: "CC" as const,
      docNumber: "1020304050",
      email: "juana.gomez@gmail.com",
      ccEmails: ["conta@empresa.test"],
      fromSavedCustomer: true,
    };
    const forDiner = invoiceSummaryFor(row, false);
    const text = JSON.stringify(forDiner);
    expect(text).not.toContain("Juana");
    expect(text).not.toContain("juana.gomez@gmail.com");
    expect(text).not.toContain("conta@empresa.test");
    expect(forDiner).toMatchObject({ masked: true, docNumber: "1020304050" });
    // El personal ve todo; y lo que escribió el propio comensal no se enmascara.
    expect(invoiceSummaryFor(row, true)).toMatchObject({ customerName: "Juana Gómez Ruiz", email: "juana.gomez@gmail.com" });
    expect(invoiceSummaryFor({ ...row, fromSavedCustomer: false }, false)).not.toHaveProperty("masked");
  });
});

describe("pickBestCustomer: filas viejas sin normalizar no se borran, se elige una", () => {
  const base = { email: null, phone: null, address: null, municipalityCode: null };
  it("gana la normalizada, después la más completa, después la más reciente", () => {
    const legacy = { ...base, id: "legacy", docNumber: "1.020.304.050", email: "a@e.test", phone: "300", updatedAt: new Date("2026-11-01") };
    const exact = { ...base, id: "exact", docNumber: "1020304050", updatedAt: new Date("2026-01-01") };
    expect(pickBestCustomer([legacy, exact], "1020304050")?.id).toBe("exact");
    const complete = { ...base, id: "complete", docNumber: "1.020.304.050", email: "a@e.test", phone: "300", updatedAt: new Date("2026-01-01") };
    const recent = { ...base, id: "recent", docNumber: "1020.304.050", email: "a@e.test", updatedAt: new Date("2026-11-01") };
    expect(pickBestCustomer([recent, complete], "1020304050")?.id).toBe("complete");
    const newer = { ...complete, id: "newer", updatedAt: new Date("2026-11-02") };
    expect(pickBestCustomer([complete, newer], "1020304050")?.id).toBe("newer");
    expect(pickBestCustomer([], "1")).toBeNull();
  });
});

describe("decideMemoryAction: quién puede cambiar un cliente guardado", () => {
  const selfService: ExistingCustomer = {
    selfService: true,
    creditEnabled: false,
    discountEnabled: false,
    hasBenefitHistory: false,
    customerName: "Ana Pérez",
    email: "ana@correo.test",
    ccEmails: [],
    rememberOptOutAt: null,
  };
  const staffMade: ExistingCustomer = { ...selfService, selfService: false };
  const incoming = { customerName: "Otra Persona", email: "otro@correo.test" };

  it("documento nuevo: lo crea; de autoservicio salvo que lo cree un administrador", () => {
    expect(decideMemoryAction({ actor: "diner", remember: true, existing: null, incoming })).toEqual({ kind: "create", selfService: true });
    expect(decideMemoryAction({ actor: "assistant", remember: true, existing: null, incoming })).toEqual({ kind: "create", selfService: true });
    expect(decideMemoryAction({ actor: "manager", remember: true, existing: null, incoming })).toEqual({ kind: "create", selfService: false });
  });

  it("el comensal NO sobrescribe un cliente que creó o editó el personal", () => {
    expect(decideMemoryAction({ actor: "diner", remember: true, existing: staffMade, incoming })).toEqual({ kind: "none", reason: "protected" });
    expect(decideMemoryAction({ actor: "assistant", remember: true, existing: staffMade, incoming })).toEqual({ kind: "none", reason: "protected" });
  });

  it.each([
    ["crédito", { creditEnabled: true }],
    ["descuento", { discountEnabled: true }],
    ["bonos o cartera", { hasBenefitHistory: true }],
  ])("el comensal NO sobrescribe uno de autoservicio con %s", (_label, extra) => {
    const withBenefit = { ...selfService, ...extra };
    expect(editableBySelfService(withBenefit)).toBe(false);
    expect(decideMemoryAction({ actor: "diner", remember: true, existing: withBenefit, incoming })).toEqual({ kind: "none", reason: "protected" });
    expect(decideMemoryAction({ actor: "diner", remember: false, existing: withBenefit, incoming })).toEqual({ kind: "none", reason: "not_remembered" });
  });

  it("el comensal sí actualiza un registro de autoservicio sin beneficios", () => {
    expect(decideMemoryAction({ actor: "diner", remember: true, existing: selfService, incoming })).toEqual({
      kind: "update",
      fields: ["customerName", "email"],
      selfService: true,
    });
    expect(
      decideMemoryAction({ actor: "diner", remember: true, existing: selfService, incoming: { customerName: "Ana Pérez", email: "ANA@correo.test" } }),
    ).toEqual({ kind: "none", reason: "unchanged" });
  });

  it("el administrador corrige cualquiera y lo deja como del personal", () => {
    expect(decideMemoryAction({ actor: "manager", remember: true, existing: staffMade, incoming })).toEqual({
      kind: "update",
      fields: ["customerName", "email"],
      selfService: false,
    });
    expect(decideMemoryAction({ actor: "manager", remember: true, existing: selfService, incoming })).toMatchObject({ kind: "update", selfService: false });
  });

  it("casilla desmarcada: nada se guarda; uno de autoservicio deja de ofrecerse; uno del personal no se toca", () => {
    expect(decideMemoryAction({ actor: "diner", remember: false, existing: null, incoming })).toEqual({ kind: "none", reason: "not_remembered" });
    expect(decideMemoryAction({ actor: "diner", remember: false, existing: selfService, incoming })).toEqual({ kind: "opt_out" });
    expect(decideMemoryAction({ actor: "diner", remember: false, existing: staffMade, incoming })).toEqual({ kind: "none", reason: "not_remembered" });
    expect(decideMemoryAction({ actor: "manager", remember: false, existing: staffMade, incoming })).toEqual({ kind: "none", reason: "not_remembered" });
    // Ya desmarcado antes: no se vuelve a marcar.
    expect(decideMemoryAction({ actor: "diner", remember: false, existing: { ...selfService, rememberOptOutAt: new Date() }, incoming })).toEqual({ kind: "none", reason: "not_remembered" });
  });

  it("volver a marcar la casilla con los mismos datos reactiva el registro desmarcado", () => {
    const optedOut = { ...selfService, rememberOptOutAt: new Date() };
    expect(decideMemoryAction({ actor: "diner", remember: true, existing: optedOut, incoming: { customerName: "Ana Pérez", email: "ana@correo.test" } })).toEqual({ kind: "update", fields: [], selfService: true });
  });

  it("correos adicionales: sólo se comparan si quien pide los mandó (el comensal no los ve)", () => {
    const withCc = { ...selfService, ccEmails: ["conta@empresa.test"] };
    const same = { customerName: "Ana Pérez", email: "ana@correo.test" };
    expect(decideMemoryAction({ actor: "diner", remember: true, existing: withCc, incoming: same })).toEqual({ kind: "none", reason: "unchanged" });
    expect(decideMemoryAction({ actor: "manager", remember: true, existing: withCc, incoming: { ...same, ccEmails: ["CONTA@empresa.test"] } })).toEqual({ kind: "none", reason: "unchanged" });
    expect(decideMemoryAction({ actor: "manager", remember: true, existing: withCc, incoming: { ...same, ccEmails: [] } })).toEqual({ kind: "update", fields: ["ccEmails"], selfService: false });
  });
});

describe("token de \"Usar estos datos\"", () => {
  beforeEach(() => vi.stubEnv("AUTH_SECRET", "test-only-secret"));
  afterEach(() => vi.unstubAllEnvs());

  it("es corto, firmado y sólo vale para su comercio y su orden", () => {
    const token = signLookupToken("rest-1", "order-1");
    expect(token.length).toBeLessThanOrEqual(50);
    expect(verifyLookupToken(token, "rest-1", "order-1")).toBe(true);
    expect(verifyLookupToken(token, "rest-1", "order-2")).toBe(false);
    expect(verifyLookupToken(token, "rest-2", "order-1")).toBe(false);
    const [nonce] = token.split(".");
    expect(verifyLookupToken(`${nonce}.AAAAAAAAAAAAAAAAAAAAAA`, "rest-1", "order-1")).toBe(false);
    expect(verifyLookupToken(`${token}.extra`, "rest-1", "order-1")).toBe(false);
    expect(verifyLookupToken("", "rest-1", "order-1")).toBe(false);
  });

  it("no lleva el id del cliente y cada token es distinto; en la DB sólo va el hash", () => {
    const a = signLookupToken("rest-1", "order-1");
    const b = signLookupToken("rest-1", "order-1");
    expect(a).not.toBe(b);
    expect(hashLookupToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashLookupToken(a)).not.toContain(a);
  });
});

describe("orderAcceptsLookup: sólo dentro de una orden viva", () => {
  const now = new Date("2026-11-13T20:00:00Z").getTime();
  it("abierta sí; cancelada o con factura generada no", () => {
    expect(orderAcceptsLookup({ status: "served", paidAt: null }, false, now)).toBe(true);
    expect(orderAcceptsLookup({ status: "cancelled", paidAt: null }, false, now)).toBe(false);
    expect(orderAcceptsLookup({ status: "served", paidAt: null }, true, now)).toBe(false);
  });
  it("pagada: sólo durante las 24 horas siguientes (la factura se puede pedir después de pagar)", () => {
    expect(orderAcceptsLookup({ status: "paid", paidAt: new Date(now - 3600_000) }, false, now)).toBe(true);
    expect(orderAcceptsLookup({ status: "paid", paidAt: new Date(now - 25 * 3600_000) }, false, now)).toBe(false);
    expect(orderAcceptsLookup({ status: "paid", paidAt: null }, false, now)).toBe(false);
  });
});
