import { describe, expect, it } from "vitest";
import {
  SIMPLE_INVOICE_WITHOUT_EMAIL,
  checkOptionalInvoiceEmail,
  isSimpleInvoiceRequested,
  simpleInvoiceEmailFrom,
} from "./simpleInvoiceRequest";

// La factura genérica se puede pedir SIN correo (sólo para imprimirla). El
// formulario valida con `checkOptionalInvoiceEmail` en todos los puntos de
// entrada, y el pedido se guarda en `Order.simpleInvoiceEmail` con tres
// estados: null (nadie la pidió), "" (sin correo), "a@b.co" (con correo).

describe("checkOptionalInvoiceEmail — el campo de correo de la genérica", () => {
  it("vacío es válido: la factura se genera igual, sólo para imprimir", () => {
    expect(checkOptionalInvoiceEmail("")).toEqual({ ok: true, email: null });
    expect(checkOptionalInvoiceEmail("   ")).toEqual({ ok: true, email: null });
    expect(checkOptionalInvoiceEmail(null)).toEqual({ ok: true, email: null });
    expect(checkOptionalInvoiceEmail(undefined)).toEqual({ ok: true, email: null });
  });

  it("un correo válido pasa, sin espacios alrededor", () => {
    expect(checkOptionalInvoiceEmail("  ana@correo.com ")).toEqual({
      ok: true,
      email: "ana@correo.com",
    });
  });

  it("un correo inválido sigue dando error", () => {
    for (const bad of ["ana", "ana@", "ana@correo", "@correo.com", "ana @correo.com"]) {
      expect(checkOptionalInvoiceEmail(bad)).toEqual({
        ok: false,
        error: "invalid_email",
      });
    }
  });
});

describe("Order.simpleInvoiceEmail — tres estados en la misma columna", () => {
  it("null: nadie pidió la genérica", () => {
    expect(isSimpleInvoiceRequested(null)).toBe(false);
    expect(isSimpleInvoiceRequested(undefined)).toBe(false);
    expect(simpleInvoiceEmailFrom(null)).toBeNull();
  });

  it("vacío: la pidieron sin correo — cuenta como pedida, pero no hay a quién mandarla", () => {
    expect(SIMPLE_INVOICE_WITHOUT_EMAIL).toBe("");
    expect(isSimpleInvoiceRequested(SIMPLE_INVOICE_WITHOUT_EMAIL)).toBe(true);
    expect(simpleInvoiceEmailFrom(SIMPLE_INVOICE_WITHOUT_EMAIL)).toBeNull();
    expect(simpleInvoiceEmailFrom("   ")).toBeNull();
  });

  it("con correo: pedida y con destinatario", () => {
    expect(isSimpleInvoiceRequested("ana@correo.com")).toBe(true);
    expect(simpleInvoiceEmailFrom(" ana@correo.com ")).toBe("ana@correo.com");
  });
});
