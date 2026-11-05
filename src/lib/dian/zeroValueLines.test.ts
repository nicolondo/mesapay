// FAW01 — «Línea de factura informado con LineExtensionAmount en cero y
// grupo cac:PricingReference no informado». La DIAN rechazó facturas de
// cuentas con un postre de cumpleaños en $0 (8 platos cobrados + 1 en
// cero). Los ítems sin valor no van a la factura: el XML lleva sólo las
// líneas con valor, numeradas de corrido, y los totales no cambian.
import { describe, expect, it } from "vitest";
import { billableDianLines, buildDianInvoiceXml, type DianInvoiceInput, type DianParty } from "./ubl";
import { embeddedMenuTax, orderToInvoiceLines, type OrderItemForInvoice } from "./emit";

const supplier: DianParty = {
  name: "Emisor de prueba S.A.S.",
  companyId: "900373076",
  dv: "5",
  idSchemeName: "31",
  taxLevelCode: "O-13",
  taxRegimeCode: "49",
  personType: "1",
  address: {
    cityCode: "05266",
    cityName: "Envigado",
    deptCode: "05",
    deptName: "Antioquia",
    line: "Calle 1 # 2-3",
  },
  email: "facturacion@example.test",
};
const consumidorFinal: DianParty = {
  name: "Consumidor final",
  companyId: "222222222222",
  idSchemeName: "13",
  taxLevelCode: "R-99-PN",
  taxRegimeCode: "49",
  personType: "2",
};

const INC8 = { kind: "inc" as const, pct: 8 };
const item = (name: string, priceCents: number, over: Partial<OrderItemForInvoice> = {}): OrderItemForInvoice => ({
  nameSnapshot: name,
  qty: 1,
  priceCentsSnapshot: priceCents,
  cancelledAt: null,
  taxKind: null,
  taxPct: null,
  ...over,
});

/** La forma real del caso: ocho platos cobrados y un postre de cumpleaños en $0. */
const PAID = [
  item("Arepa de chócolo", 18_000_00),
  item("Patacón con hogao", 15_000_00, { qty: 2 }),
  item("Bandeja paisa", 42_000_00),
  item("Limonada de coco", 12_000_00, { qty: 3 }),
  item("Cerveza artesanal", 14_000_00),
  item("Ajiaco", 32_000_00),
  item("Mazorca desgranada", 28_000_00),
  item("Café", 6_000_00, { qty: 2 }),
];
const FREE = item("ZPostre Cumpleaños", 0);

function build(lines = orderToInvoiceLines([...PAID.slice(0, 4), FREE, ...PAID.slice(4)], INC8)) {
  const input: DianInvoiceInput = {
    environment: "1",
    softwareId: "soft-1",
    softwarePin: "1234",
    technicalKey: "clave-tecnica",
    resolution: { number: "18760000001", startDate: "2026-01-01", endDate: "2030-01-01", prefix: "FESM", from: 1, to: 10000 },
    invoiceNumber: "FESM7913",
    issueDate: "2026-11-04",
    issueTime: "13:00:00-05:00",
    supplier,
    customer: consumidorFinal,
    lines,
    paymentMeansCode: "10",
  };
  return buildDianInvoiceXml(input);
}

const lineBlocks = (xml: string) => xml.split("<cac:InvoiceLine>").slice(1);

describe("ítems en $0 (FAW01)", () => {
  it("el mapeo de la orden no produce línea para el ítem en $0", () => {
    const lines = orderToInvoiceLines([...PAID, FREE], INC8);
    expect(lines).toHaveLength(8);
    expect(lines.map((l) => l.description)).not.toContain("ZPostre Cumpleaños");
    expect(lines.every((l) => l.lineTotalCents > 0)).toBe(true);
  });

  it("el XML no lleva ninguna línea con LineExtensionAmount 0.00 ni PricingReference", () => {
    const { xml } = build();
    const blocks = lineBlocks(xml);
    expect(blocks).toHaveLength(8);
    for (const b of blocks) {
      expect(b).not.toMatch(/<cbc:LineExtensionAmount currencyID="COP">0\.00</);
    }
    expect(xml).not.toContain("ZPostre Cumpleaños");
    expect(xml).not.toContain("PricingReference");
  });

  it("la numeración cbc:ID de las líneas es consecutiva y LineCountNumeric cuenta lo mismo", () => {
    const { xml } = build();
    const ids = lineBlocks(xml).map((b) => /<cbc:ID>(\d+)<\/cbc:ID>/.exec(b)?.[1]);
    expect(ids).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    expect(xml).toContain("<cbc:LineCountNumeric>8</cbc:LineCountNumeric>");
  });

  it("los totales (y por lo tanto el CUFE) son los mismos que sin el ítem en $0", () => {
    const withFree = build();
    const without = build(orderToInvoiceLines(PAID, INC8));
    expect(withFree.totals).toEqual(without.totals);
    expect(withFree.cufe).toBe(without.cufe);
    // Cobrado: 18k + 30k + 42k + 36k + 14k + 32k + 28k + 12k = 212.000 con INC.
    expect(withFree.totals.payableCents).toBe(212_000_00);
    expect(withFree.xml).toContain('<cbc:PayableAmount currencyID="COP">212000.00</cbc:PayableAmount>');
  });

  it("el impuesto congelado en la tirilla no cambia por el ítem en $0", () => {
    expect(embeddedMenuTax([...PAID, FREE], INC8)).toEqual(embeddedMenuTax(PAID, INC8));
  });

  it("la cortesía (ítem 'no cobrado' = cancelado) y una línea libre en $0 tampoco salen", () => {
    const comped = item("Cortesía de la casa", 9_000_00, { cancelledAt: new Date("2026-11-04T17:00:00Z") });
    const freeLine = item("Servicio de mesa", 0, { taxKind: "iva", taxPct: 19 });
    const lines = orderToInvoiceLines([...PAID, comped, freeLine], INC8);
    expect(lines).toHaveLength(8);
    expect(lines.map((l) => l.description)).not.toContain("Cortesía de la casa");
    expect(lines.map((l) => l.description)).not.toContain("Servicio de mesa");
  });

  it("el builder filtra solo aunque le lleguen líneas en cero (red para cualquier ruta)", () => {
    const lines = orderToInvoiceLines(PAID, INC8);
    const zero = { ...lines[0], description: "Modificador gratis", unitPriceCents: 0, lineTotalCents: 0, taxCents: 0 };
    expect(billableDianLines([zero, ...lines])).toHaveLength(8);
    const { xml, totals } = build([lines[0], zero, ...lines.slice(1)]);
    expect(lineBlocks(xml)).toHaveLength(8);
    expect(xml).not.toContain("Modificador gratis");
    expect(totals).toEqual(build(lines).totals);
  });

  it("una cuenta SÓLO con ítems en $0 no tiene líneas facturables", () => {
    expect(orderToInvoiceLines([FREE, item("Agua", 0)], INC8)).toEqual([]);
  });
});
