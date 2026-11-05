// La factura electrónica impresa dice lo mismo que el XML: los productos en
// $0 no son líneas fiscales (no van a la DIAN, regla FAW01) y salen aparte,
// como nota «Sin costo …». El comprobante (sin DIAN) no cambia. Los totales
// tampoco: una línea en cero no suma nada.
import { describe, expect, it } from "vitest";
import type { InvoiceSnapshot } from "@/lib/invoice";
import { freeLinesText, splitZeroValueLines } from "@/lib/invoiceLines";
import { parseInvoicePayload, renderInvoice, INVOICE_PAYLOAD_VERSION } from "@/lib/escpos/invoice";
import { buildThermalInvoice } from "./invoiceDoc";

const t = (key: string, values?: Record<string, string | number>) =>
  values ? `${key}(${Object.values(values).join("|")})` : key;
const money = (cents: number) => `$${Math.round(cents / 100)}`;

const snapshot: InvoiceSnapshot = {
  restaurantName: "Comercio de prueba",
  logoUrl: null,
  legalName: "Comercio de prueba S.A.S.",
  taxId: "900.373.076-5",
  legalAddress: "Calle 1 # 2-3",
  legalCity: "Envigado",
  legalPhone: null,
  dianResolution: "18760000001",
  dianResolutionFrom: 1,
  dianResolutionTo: 10000,
  dianResolutionDate: "2026-01-15T00:00:00.000Z",
  invoicePrefix: "FESM",
  shortCode: "A4F2",
  tableLabel: "Mesa 7",
  paidAtIso: "2026-11-04T19:41:00.000Z",
  items: [
    { qty: 1, name: "Bandeja paisa", priceCents: 4_200_000 },
    { qty: 1, name: "ZPostre Cumpleaños", priceCents: 0 },
    { qty: 2, name: "Limonada", priceCents: 1_200_000 },
  ],
  subtotalCents: 6_600_000,
  taxCents: 0,
  discountCents: 0,
  tipCents: 0,
  totalCents: 6_600_000,
  customer: null,
};

const dian = { cufe: "a".repeat(96), verifyUrl: "https://catalogo-vpfe.dian.gov.co/x", qr: true };
const build = (withDian: boolean) =>
  buildThermalInvoice({
    snapshot,
    invoiceNumber: 7913,
    paperWidthMm: 80,
    paidAtLabel: "4/11/26, 14:41",
    dianResolutionDateLabel: "15/01/26",
    payments: [],
    money,
    t,
    dian: withDian ? dian : null,
  });

describe("productos en $0 en la factura impresa", () => {
  it("splitZeroValueLines separa lo cobrado de lo que va sin costo", () => {
    const { charged, free } = splitZeroValueLines(snapshot.items);
    expect(charged.map((i) => i.name)).toEqual(["Bandeja paisa", "Limonada"]);
    expect(free.map((i) => i.name)).toEqual(["ZPostre Cumpleaños"]);
    expect(freeLinesText([...free, ...free])).toBe("2× ZPostre Cumpleaños");
  });

  it("factura electrónica: el $0 no está entre las líneas, va como nota; el total no cambia", () => {
    const doc = build(true);
    expect(doc.items.map((i) => i.name)).toEqual(["Bandeja paisa", "Limonada"]);
    expect(doc.itemsNote).toBe("freeItemsNote(1× ZPostre Cumpleaños)");
    expect(doc.totals.at(-1)).toMatchObject({ label: "total", amount: "$66000" });
  });

  it("comprobante (sin DIAN): todo como siempre, sin nota", () => {
    const doc = build(false);
    expect(doc.items.map((i) => i.name)).toEqual(["Bandeja paisa", "ZPostre Cumpleaños", "Limonada"]);
    expect(doc.itemsNote).toBeUndefined();
  });

  it("la nota viaja en el payload y sale impresa; un payload viejo sin nota sigue valiendo", () => {
    const doc = build(true);
    const parsed = parseInvoicePayload({ v: INVOICE_PAYLOAD_VERSION, invoice: doc });
    expect(parsed?.itemsNote).toBe(doc.itemsNote);
    expect(renderInvoice(parsed!).toString("latin1")).toContain("freeItemsNote(1");
    const { itemsNote: _drop, ...old } = doc;
    void _drop;
    expect(parseInvoicePayload({ v: INVOICE_PAYLOAD_VERSION, invoice: old })?.itemsNote).toBeUndefined();
  });
});
