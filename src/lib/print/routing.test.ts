import { describe, expect, it } from "vitest";
import {
  invoiceDedupeKey,
  invoicePrintDecision,
  invoicePrinterWhere,
} from "./routing";

/**
 * Las reglas puras de la impresión de la factura: cuándo sale papel y
 * por dónde. Son las que hacen que un comercio con facturación
 * electrónica NO saque la tirilla al cobrar (sale la factura electrónica
 * al aceptarla la DIAN) y que la impresora elegida en Configuración sea
 * la única que la recibe.
 */
describe("invoicePrintDecision — ¿sale papel?", () => {
  it("sin facturación electrónica, el cobro imprime el comprobante", () => {
    expect(
      invoicePrintDecision({ trigger: "paid", autoPrint: true, einvoicing: false }),
    ).toBe("print");
  });

  it("con facturación electrónica, el cobro NO imprime: espera a la DIAN", () => {
    expect(
      invoicePrintDecision({ trigger: "paid", autoPrint: true, einvoicing: true }),
    ).toBe("skip_waits_dian");
  });

  it("la aceptación de la DIAN imprime la factura electrónica", () => {
    expect(
      invoicePrintDecision({
        trigger: "dian_accepted",
        autoPrint: true,
        einvoicing: true,
      }),
    ).toBe("print");
  });

  it("con el automático apagado no imprime ni el cobro ni la aceptación", () => {
    expect(
      invoicePrintDecision({ trigger: "paid", autoPrint: false, einvoicing: false }),
    ).toBe("skip_auto_off");
    expect(
      invoicePrintDecision({
        trigger: "dian_accepted",
        autoPrint: false,
        einvoicing: true,
      }),
    ).toBe("skip_auto_off");
  });

  it("la reimpresión manual imprime SIEMPRE, con el automático apagado y con la DIAN de por medio", () => {
    expect(
      invoicePrintDecision({ trigger: "reprint", autoPrint: false, einvoicing: true }),
    ).toBe("print");
    expect(
      invoicePrintDecision({ trigger: "reprint", autoPrint: true, einvoicing: false }),
    ).toBe("print");
  });
});

describe("invoicePrinterWhere — a qué impresoras", () => {
  it("sin elección: todas las de tipo factura activas, como siempre", () => {
    expect(invoicePrinterWhere("rest-1", null)).toEqual({
      restaurantId: "rest-1",
      active: true,
      kind: "factura",
    });
  });

  it("con elección: SÓLO esa, activa, sin mirar el tipo (puede ser de comanda)", () => {
    const where = invoicePrinterWhere("rest-1", "p-cocina");
    expect(where).toEqual({ restaurantId: "rest-1", active: true, id: "p-cocina" });
    expect(where).not.toHaveProperty("kind");
  });

  it("siempre acotado al comercio y a las activas", () => {
    for (const chosen of [null, "p-1"]) {
      const where = invoicePrinterWhere("rest-9", chosen);
      expect(where.restaurantId).toBe("rest-9");
      expect(where.active).toBe(true);
    }
  });
});

describe("invoiceDedupeKey", () => {
  it("es la misma clave para el comprobante del cobro y la factura electrónica de la aceptación", () => {
    expect(invoiceDedupeKey("inv-1")).toBe("invoice:inv-1");
  });
});
