import { describe, expect, it, vi } from "vitest";
vi.mock("./payments/kushki/cloudTerminal", () => ({}));
import {
  formatInvoiceNumber,
  renderInvoiceEmail,
  taxRows,
  type InvoiceSnapshot,
} from "./invoice";
import { getEmailTranslator } from "./emailIntl";
import { buildThermalInvoice } from "./print/invoiceDoc";
import { renderInvoice } from "./escpos/invoice";
import { columnsForWidth } from "./escpos/commands";
import { buildInvoiceCommands } from "./payments/kushki/cloudPrint";

const LABELS = { inc: "Impoconsumo", iva: "IVA", other: "Impuestos" };

/** Snapshot mínimo: `taxRows` sólo mira los campos de impuesto. */
function snap(tax: Partial<InvoiceSnapshot>): InvoiceSnapshot {
  return {
    restaurantName: "Test",
    logoUrl: null,
    legalName: null,
    taxId: null,
    legalAddress: null,
    legalPhone: null,
    dianResolution: null,
    dianResolutionFrom: null,
    dianResolutionTo: null,
    dianResolutionDate: null,
    invoicePrefix: null,
    shortCode: "T-1000",
    tableLabel: "Mesa 1",
    paidAtIso: "2026-01-01T00:00:00.000Z",
    items: [],
    subtotalCents: 0,
    tipCents: 0,
    totalCents: 0,
    ...tax,
  };
}

// Datos reales de Son & Melona: prefijo FESM, rango 1..10000, consecutivo
// 6482. El número se armaba como "FESM-06482" y la DIAN devolvía DOS
// rechazos por el mismo bug — FAD05a (guión) y FAD05b (le quita el
// prefijo declarado y "-06482" no le cabe en 1..10000).
describe("formatInvoiceNumber", () => {
  const sonYMelona = {
    invoicePrefix: "FESM",
    dianResolutionFrom: 1,
    dianResolutionTo: 10000,
  } as const;

  it("el caso real: prefijo y consecutivo pegados, sin guión ni relleno", () => {
    expect(formatInvoiceNumber(snap(sonYMelona), 6482)).toBe("FESM6482");
  });

  it("FAD05a: ningún guión, espacio ni caracter de más", () => {
    const n = formatInvoiceNumber(snap(sonYMelona), 6482);
    expect(n).toMatch(/^[A-Z0-9]+$/);
    expect(n).not.toContain("-");
  });

  it("FAD05b: quitando el prefijo queda un consecutivo dentro del rango", () => {
    const n = formatInvoiceNumber(snap(sonYMelona), 6482);
    const consecutivo = Number(n.slice("FESM".length));
    expect(consecutivo).toBe(6482);
    expect(consecutivo).toBeGreaterThanOrEqual(1);
    expect(consecutivo).toBeLessThanOrEqual(10000);
  });

  it("sin prefijo es el consecutivo pelado", () => {
    expect(
      formatInvoiceNumber(snap({ dianResolutionTo: 10000 }), 6482),
    ).toBe("6482");
  });

  it("sin resolución cargada tampoco se rellena", () => {
    // Antes el ancho salía de dianResolutionTo; ya no se usa para nada.
    expect(formatInvoiceNumber(snap({ invoicePrefix: "FESM" }), 42)).toBe(
      "FESM42",
    );
    expect(formatInvoiceNumber(snap({}), 42)).toBe("42");
  });

  it("el rango no cambia el ancho del número", () => {
    for (const to of [null, 5000, 10000, 999_999_999]) {
      expect(
        formatInvoiceNumber(snap({ invoicePrefix: "FE", dianResolutionTo: to }), 42),
      ).toBe("FE42");
    }
  });
});

describe("taxRows", () => {
  it("una cuenta sólo de menú no muestra ninguna fila", () => {
    // El impuesto de los platos va EMBEBIDO en el precio y ya está contado
    // dentro del subtotal: una fila aparte haría parecer que se cobra dos
    // veces.
    expect(taxRows(snap({}), LABELS)).toEqual([]);
    expect(
      taxRows(snap({ taxCents: 0, taxByKind: { inc: 0, iva: 0 } }), LABELS),
    ).toEqual([]);
  });

  it("un servicio con IVA encima sale como su propia fila", () => {
    const rows = taxRows(
      snap({ taxCents: 456_000_00, taxByKind: { inc: 0, iva: 456_000_00 } }),
      LABELS,
    );
    expect(rows).toEqual([{ label: "IVA", cents: 456_000_00 }]);
  });

  it("desglosa cuando la cuenta mezcla impoconsumo e IVA", () => {
    // El punto entero de las líneas libres: un restaurante que cobra
    // impoconsumo factura un servicio con IVA en la misma cuenta.
    const rows = taxRows(
      snap({ taxCents: 30_000, taxByKind: { inc: 8_000, iva: 22_000 } }),
      LABELS,
    );
    expect(rows).toEqual([
      { label: "Impoconsumo", cents: 8_000 },
      { label: "IVA", cents: 22_000 },
    ]);
  });

  it("una factura vieja sin desglose muestra el total en una fila genérica", () => {
    // Back-compat: snapshots emitidos antes del desglose sólo tienen el
    // total. Igual tiene que cuadrar subtotal + impuesto + propina = total.
    const rows = taxRows(snap({ taxCents: 19_000 }), LABELS);
    expect(rows).toEqual([{ label: "Impuestos", cents: 19_000 }]);
  });

  it("si el desglose no cubre el total, el resto va a la fila genérica", () => {
    const rows = taxRows(
      snap({ taxCents: 30_000, taxByKind: { inc: 0, iva: 22_000 } }),
      LABELS,
    );
    expect(rows).toEqual([
      { label: "IVA", cents: 22_000 },
      { label: "Impuestos", cents: 8_000 },
    ]);
  });
});


const tipNoticeTitle = "ADVERTENCIA DE PROPINA";
const tipNoticeBody = "POR DISPOSICION DE LA SUPERINTENDENCIA DE INDUSTRIA Y COMERCIO SE INFORMA QUE LA PROPINA ES SUGUERIDA AL CONSUMIDOR LA CUAL PODRA SER ACEPTADA, RECHAZADA O MODIFICADO POR USTED, DE ACUERDO CON SU VALORACION DEL SERVICIO PRESTADO.";
const invoiceUrl = "https://mesapay.co/factura/test";

describe("advertencia de propina — documento completo", () => {
  it.each([0, 10_000])("con propina %i conserva el texto solicitado en ambos formatos del correo", async (tipCents) => {
    const email = await renderInvoiceEmail({
      snapshot: snap({ tipCents }), invoiceNumber: 1, invoiceUrl, locale: "es",
    });
    for (const output of [email.html, email.text]) {
      expect(output).toContain(tipNoticeTitle);
      expect(output).toContain(tipNoticeBody);
      expect(output.split(tipNoticeTitle)).toHaveLength(2);
    }
  });

  it.each(["es", "en", "pt"])("correo y tirilla usan traducciones reales en %s", async (locale) => {
    const { t } = await getEmailTranslator(locale, "emailInvoice");
    const title = t("tipNoticeTitle");
    const body = t("tipNoticeBody");
    expect(title).not.toContain("tipNoticeTitle");
    expect(body).not.toContain("tipNoticeBody");
    expect(body.length).toBeGreaterThan(100);
    const email = await renderInvoiceEmail({ snapshot: snap({}), invoiceNumber: 1, invoiceUrl, locale });
    const doc = buildThermalInvoice({
      snapshot: snap({}), invoiceNumber: 1, paperWidthMm: 80,
      paidAtLabel: "01/01/26", dianResolutionDateLabel: null, payments: [], money: String, t,
    });
    const commands = buildInvoiceCommands(snap({}), 1, invoiceUrl, t);
    const cloudText = commands.flatMap((command) => command.type === "text" ? [command.text] : []).join("\n").replace(/\s+/g, " ");
    for (const output of [email.html, email.text, doc.footerLines.join("\n"), cloudText]) {
      expect(output).toContain(title);
      expect(output).toContain(body);
    }
  });

  it.each([58, 80])("la tirilla de %imm imprime todas las palabras, sin cortar líneas", async (paperWidthMm) => {
    const { t } = await getEmailTranslator("es", "emailInvoice");
    const doc = buildThermalInvoice({
      snapshot: snap({}), invoiceNumber: 1, paperWidthMm,
      paidAtLabel: "01/01/26", dianResolutionDateLabel: null, payments: [], money: String, t,
    });
    expect(doc.footerLines).toContain(tipNoticeTitle);
    expect(doc.footerLines).toContain(tipNoticeBody);
    // El aviso es ASCII: retiramos únicamente los comandos ESC/POS del papel.
    const paper = renderInvoice(doc).toString("latin1")
      .replace(/\x1b@/g, "")
      .replace(/\x1b[taEd][\s\S]/g, "")
      .replace(/\x1d![\s\S]/g, "")
      .replace(/\x1dV[\s\S]{2}/g, "");
    expect(paper.replace(/\s+/g, " ")).toContain(tipNoticeTitle + " " + tipNoticeBody);
    for (const line of paper.split("\n")) expect(line.length).toBeLessThanOrEqual(columnsForWidth(paperWidthMm));
  });

  it.each([0, 10_000])("el datáfono recibe el aviso completo incluso con propina %i", (tipCents) => {
    const commands = buildInvoiceCommands(snap({ tipCents }), 1, invoiceUrl);
    const text = commands.flatMap((command) => command.type === "text" ? [command.text] : []).join("\n");
    expect(text.replace(/\s+/g, " ")).toContain(tipNoticeTitle + " " + tipNoticeBody);
    expect(text.split(tipNoticeTitle)).toHaveLength(2);
    expect(commands.at(-1)?.type).toBe("cut");
  });
});
