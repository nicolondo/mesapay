import { describe, expect, it } from "vitest";
import type { InvoiceSnapshot } from "@/lib/invoice";
import { buildThermalInvoice, paymentRowsFor } from "./invoiceDoc";

/**
 * Qué lleva la tirilla del cliente. Los textos van sin traducir a
 * propósito —el traductor entra por parámetro y acá devuelve la clave—
 * porque lo que se prueba es QUÉ filas salen y cuáles NO: el descuento
 * que aparece sólo si es > 0, el impuesto que en una cuenta de puro menú
 * no va (ya está embebido en el precio, una fila aparte parecería un
 * cobro doble), y el bloque del cliente que sólo existe si la factura es
 * nominativa.
 */
const t = (key: string, values?: Record<string, string | number>) =>
  values ? `${key}(${Object.values(values).join("|")})` : key;

const money = (cents: number) => `$${Math.round(cents / 100)}`;

const snapshot: InvoiceSnapshot = {
  restaurantName: "Donde Chucho",
  logoUrl: null,
  legalName: "Inversiones Chucho S.A.S.",
  taxId: "900.123.456-7",
  legalAddress: "Calle 12 #4-56",
  legalCity: "Medellín",
  legalPhone: "604 444 5566",
  dianResolution: "18764012345678",
  dianResolutionFrom: 1,
  dianResolutionTo: 5000,
  dianResolutionDate: "2026-01-15T00:00:00.000Z",
  invoicePrefix: "FE",
  shortCode: "A4F2",
  tableLabel: "Mesa 7",
  paidAtIso: "2026-09-08T19:41:00.000Z",
  items: [
    { qty: 2, name: "Bandeja paisa", priceCents: 2_450_000 },
    { qty: 1, name: "Limonada de coco", priceCents: 1_200_000 },
  ],
  subtotalCents: 6_100_000,
  taxCents: 0,
  discountCents: 0,
  tipCents: 0,
  totalCents: 6_100_000,
  customer: null,
};

function build(over: Partial<InvoiceSnapshot> = {}, payments = []) {
  return buildThermalInvoice({
    snapshot: { ...snapshot, ...over },
    invoiceNumber: 42,
    paperWidthMm: 80,
    paidAtLabel: "8/09/26, 19:41",
    dianResolutionDateLabel: "15/01/26",
    payments,
    money,
    t,
  });
}

describe("buildThermalInvoice — identidad del comercio", () => {
  it("manda la razón social, no el nombre comercial", () => {
    expect(build().businessName).toBe("Inversiones Chucho S.A.S.");
  });

  it("sin razón social cargada cae al nombre del restaurante", () => {
    expect(build({ legalName: null }).businessName).toBe("Donde Chucho");
    expect(build({ legalName: "   " }).businessName).toBe("Donde Chucho");
  });

  it("omite los renglones que el comercio no cargó en vez de dejarlos vacíos", () => {
    const doc = build({ taxId: null, legalPhone: null, legalCity: null });
    expect(doc.businessLines).toEqual(["Calle 12 #4-56"]);
  });

  it("el número lleva prefijo y el padding de la resolución DIAN", () => {
    expect(build().documentNumber).toBe("FE-0042");
  });
});

describe("buildThermalInvoice — el cliente", () => {
  it("una tirilla a consumidor final no tiene bloque de cliente", () => {
    expect(build().customerLines).toEqual([]);
  });

  it("la factura nominativa trae nombre, documento y dirección", () => {
    const doc = build({
      customer: {
        name: "Inversiones Ñandú S.A.S.",
        docType: "NIT",
        docNumber: "900.987.654-3",
        address: "Carrera 43A #1-50",
        city: "Medellín",
        department: "Antioquia",
      },
    });
    expect(doc.customerLines).toEqual([
      "customerLabel: Inversiones Ñandú S.A.S.",
      "NIT 900.987.654-3",
      "Carrera 43A #1-50, Medellín",
    ]);
  });
});

describe("buildThermalInvoice — totales", () => {
  it("una cuenta simple es subtotal y TOTAL, nada más", () => {
    expect(build().totals.map((r) => r.label)).toEqual(["subtotal", "total"]);
  });

  it("el TOTAL va marcado para imprimirse grande y es el último", () => {
    const totals = build().totals;
    expect(totals[totals.length - 1]).toMatchObject({
      label: "total",
      strong: true,
    });
    expect(totals.filter((r) => r.strong)).toHaveLength(1);
  });

  it("sin impuesto sumado encima NO hay fila de impuesto (va embebido en el precio)", () => {
    expect(build().totals.map((r) => r.label)).not.toContain("taxInc");
  });

  it("las líneas libres con impuesto sí lo desglosan por tipo", () => {
    const doc = build({
      taxCents: 752_000,
      taxByKind: { inc: 500_000, iva: 252_000 },
    });
    expect(doc.totals.map((r) => r.label)).toEqual([
      "subtotal",
      "taxInc",
      "taxIva",
      "total",
    ]);
  });

  it("el descuento va en negativo y con el porcentaje cuando lo hay", () => {
    const doc = build({ discountCents: 940_000, discountPct: 10 });
    const row = doc.totals.find((r) => r.label.startsWith("discountRow"))!;
    expect(row.label).toBe("discountRowPct(10)");
    expect(row.amount).toBe("-$9400");
  });

  it("un descuento sin porcentaje usa la etiqueta genérica", () => {
    const doc = build({ discountCents: 500_000, discountPct: null });
    expect(doc.totals.some((r) => r.label === "discountRow")).toBe(true);
  });

  it("la propina sólo aparece si la hubo", () => {
    expect(build().totals.map((r) => r.label)).not.toContain("tip");
    expect(build({ tipCents: 846_000 }).totals.map((r) => r.label)).toContain(
      "tip",
    );
  });

  it("los ítems llevan el importe de la LÍNEA, no el unitario", () => {
    expect(build().items).toEqual([
      { qty: 2, name: "Bandeja paisa", amount: "$49000" },
      { qty: 1, name: "Limonada de coco", amount: "$12000" },
    ]);
  });
});

describe("buildThermalInvoice — pie legal", () => {
  it("trae resolución, numeración autorizada, fecha y el agradecimiento", () => {
    expect(build().footerLines).toEqual([
      "dianResolution(18764012345678)",
      "dianNumbering(1|5000)",
      "dianDate(15/01/26)",
      "thanks",
    ]);
  });

  it("un comercio sin resolución DIAN sólo agradece", () => {
    const doc = buildThermalInvoice({
      snapshot: {
        ...snapshot,
        dianResolution: null,
        dianResolutionFrom: null,
        dianResolutionTo: null,
      },
      invoiceNumber: 42,
      paperWidthMm: 80,
      paidAtLabel: "8/09/26, 19:41",
      dianResolutionDateLabel: null,
      payments: [],
      money,
      t,
    });
    expect(doc.footerLines).toEqual(["thanks"]);
  });
});

describe("paymentRowsFor", () => {
  it("suma la propina al pago: si no, los pagos no cerrarían contra el total", () => {
    expect(
      paymentRowsFor(
        [{ method: "demo_cash", amountCents: 6_100_000, tipCents: 600_000 }],
        t,
        money,
      ),
    ).toEqual([{ label: "methodCash", amount: "$67000" }]);
  });

  it("agrupa por lo que el cliente reconoce, no por el riel técnico", () => {
    const rows = paymentRowsFor(
      [
        { method: "kushki_card", amountCents: 1_000_000, tipCents: 0 },
        { method: "wompi_card", amountCents: 2_000_000, tipCents: 0 },
        { method: "demo_cash", amountCents: 500_000, tipCents: 0 },
      ],
      t,
      money,
    );
    expect(rows).toEqual([
      { label: "methodCard", amount: "$30000" },
      { label: "methodCash", amount: "$5000" },
    ]);
  });

  it("el datáfono propio del comercio no se confunde con el nuestro", () => {
    const rows = paymentRowsFor(
      [
        { method: "kushki_card_terminal", amountCents: 100, tipCents: 0 },
        { method: "external_terminal", amountCents: 100, tipCents: 0 },
      ],
      t,
      money,
    );
    expect(rows.map((r) => r.label)).toEqual([
      "methodCardTerminal",
      "methodExternalTerminal",
    ]);
  });

  it("un método que este build no conoce imprime 'otro medio', no se pierde", () => {
    expect(
      paymentRowsFor(
        [{ method: "cripto_lunar", amountCents: 100_000, tipCents: 0 }],
        t,
        money,
      ),
    ).toEqual([{ label: "methodOther", amount: "$1000" }]);
  });

  it("sin pagos registrados (una cortesía) no hay bloque de forma de pago", () => {
    expect(paymentRowsFor([], t, money)).toEqual([]);
    expect(build().paymentTitle).toBeNull();
  });

  it("con pagos, el bloque tiene título", () => {
    const doc = buildThermalInvoice({
      snapshot,
      invoiceNumber: 42,
      paperWidthMm: 80,
      paidAtLabel: "8/09/26, 19:41",
      dianResolutionDateLabel: null,
      payments: [{ method: "demo_cash", amountCents: 6_100_000, tipCents: 0 }],
      money,
      t,
    });
    expect(doc.paymentTitle).toBe("paymentTitle");
    expect(doc.paymentRows).toHaveLength(1);
  });
});
