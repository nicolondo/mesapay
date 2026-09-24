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

  it("el número impreso es el MISMO que va a la DIAN: prefijo pegado, sin relleno", () => {
    // Con guión y padding la DIAN rechazaba (FAD05a/FAD05b), y el cliente
    // quedaba con una tirilla que no coincidía con el portal.
    expect(build().documentNumber).toBe("FE42");
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
      "tipNoticeTitle",
      "tipNoticeBody",
      "thanks",
    ]);
  });

  it("un comercio sin resolución DIAN conserva el aviso de propina", () => {
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
    expect(doc.footerLines).toEqual(["tipNoticeTitle", "tipNoticeBody", "thanks"]);
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

describe("buildThermalInvoice — impuesto embebido congelado en la factura", () => {
  // Bandeja + limonada = $61.000 con INC 8% embebido, repartido como el XML.
  const frozenInc = {
    salesTaxKind: "inc" as const,
    salesTaxPct: 8,
    embeddedTaxCents: 451_852,
    embeddedBaseCents: 5_648_148,
  };

  it("discrimina la base y el impoconsumo incluido debajo del subtotal", () => {
    // Lo que el dueño reclamó: el XML aceptado decía "INC 8%" y el papel
    // no. La fila es informativa (ya está dentro del subtotal): el TOTAL
    // sigue siendo el mismo.
    const doc = build(frozenInc);
    expect(doc.totals.map((r) => r.label)).toEqual([
      "subtotal",
      "taxBase",
      "taxIncIncluded(8)",
      "total",
    ]);
    expect(doc.totals.find((r) => r.label === "taxBase")?.amount).toBe("$56481");
    expect(doc.totals.find((r) => r.label === "taxIncIncluded(8)")?.amount).toBe("$4519");
    expect(doc.totals.at(-1)?.amount).toBe("$61000");
  });

  it("el embebido va antes que el impuesto sumado encima por las líneas libres", () => {
    const doc = build({
      ...frozenInc,
      taxCents: 252_000,
      taxByKind: { inc: 0, iva: 252_000 },
    });
    expect(doc.totals.map((r) => r.label)).toEqual([
      "subtotal",
      "taxBase",
      "taxIncIncluded(8)",
      "taxIva",
      "total",
    ]);
  });

  it("emitida con el comercio sin impuesto, o antes del congelado, no cambia nada", () => {
    expect(
      build({ salesTaxKind: "none", salesTaxPct: 0, embeddedTaxCents: 0, embeddedBaseCents: 6_100_000 })
        .totals.map((r) => r.label),
    ).toEqual(["subtotal", "total"]);
    expect(build().totals.map((r) => r.label)).toEqual(["subtotal", "total"]);
  });
});

describe("buildThermalInvoice — factura electrónica (dian)", () => {
  const dian = {
    cufe: "0123456789abcdef".repeat(6),
    verifyUrl:
      "https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey=" +
      "0123456789abcdef".repeat(6),
    qr: true,
  };
  const einvoice = (
    over: Partial<InvoiceSnapshot> = {},
    d: typeof dian | null = dian,
  ) =>
    buildThermalInvoice({
      snapshot: { ...snapshot, ...over },
      invoiceNumber: 42,
      paperWidthMm: 80,
      paidAtLabel: "8/09/26, 19:41",
      dianResolutionDateLabel: "15/01/26",
      payments: [],
      money,
      t,
      dian: d,
    });

  it("sin dian es el comprobante: rótulo receiptLabel, sin bloque fiscal y sin 'Consumidor final'", () => {
    const doc = einvoice({}, null);
    expect(doc.documentLabel).toBe("receiptLabel");
    expect(doc.fiscal).toBeNull();
    expect(doc.customerLines).toEqual([]);
  });

  it("con dian el rótulo es el de la factura electrónica de venta", () => {
    expect(einvoice().documentLabel).toBe("einvoiceLabel");
  });

  it("el adquiriente sin datos dice 'Consumidor final' — es lo que viajó en el XML", () => {
    expect(einvoice().customerLines).toEqual(["customerLabel: finalConsumer"]);
  });

  it("con datos del cliente, el cliente (igual que en el comprobante)", () => {
    const doc = einvoice({
      customer: { name: "Ana Pérez", docType: "CC", docNumber: "1.020.304.050" },
    });
    expect(doc.customerLines).toEqual(["customerLabel: Ana Pérez", "CC 1.020.304.050"]);
  });

  it("el bloque fiscal lleva el CUFE entero, la URL de consulta, el QR según la impresora y la leyenda", () => {
    expect(einvoice().fiscal).toEqual({
      cufeLabel: "dianCufeLabel",
      cufe: dian.cufe,
      verifyUrl: dian.verifyUrl,
      qr: true,
      verifyLabel: "einvoiceVerify",
      noticeLines: ["einvoiceRepresentation"],
    });
  });

  it("qr false cuando la impresora destino no lo soporta", () => {
    expect(einvoice({}, { ...dian, qr: false }).fiscal?.qr).toBe(false);
  });

  it("ítems, totales, número y pie son los mismos que en el comprobante: es la misma venta", () => {
    const comprobante = einvoice({}, null);
    const factura = einvoice();
    expect(factura.items).toEqual(comprobante.items);
    expect(factura.totals).toEqual(comprobante.totals);
    expect(factura.documentNumber).toBe(comprobante.documentNumber);
    expect(factura.footerLines).toEqual(comprobante.footerLines);
    expect(factura.businessLines).toEqual(comprobante.businessLines);
  });
});

describe("buildThermalInvoice — artículos repetidos AGRUPADOS", () => {
  const bretana = {
    qty: 1,
    name: "Bretaña",
    priceCents: 600_000,
    menuItemId: "mi-bretana",
    taxKind: null,
    taxPct: null,
    modifiers: [],
    notes: null,
  };

  it("dos Bretañas en dos rondas salen como UNA línea '2x' con el importe de las dos", () => {
    const doc = build({
      items: [bretana, { ...snapshot.items[0] }, { ...bretana }],
      subtotalCents: 1_200_000 + 4_900_000,
    });
    expect(doc.items).toEqual([
      { qty: 2, name: "Bretaña", amount: "$12000" },
      { qty: 2, name: "Bandeja paisa", amount: "$49000" },
    ]);
  });

  it("la suma de los importes agrupados es el subtotal del snapshot al centavo", () => {
    const items = [
      { ...bretana, priceCents: 612_345 },
      { ...bretana, priceCents: 612_345, qty: 2 },
      { qty: 1, name: "Limonada de coco", priceCents: 1_234_567 },
      { ...bretana, priceCents: 612_345 },
    ];
    const subtotalCents = items.reduce((s, i) => s + i.qty * i.priceCents, 0);
    const doc = buildThermalInvoice({
      snapshot: { ...snapshot, items, subtotalCents, totalCents: subtotalCents },
      invoiceNumber: 42,
      paperWidthMm: 80,
      paidAtLabel: "8/09/26, 19:41",
      dianResolutionDateLabel: "15/01/26",
      payments: [],
      // Centavos crudos, para sumar lo que de verdad va al papel.
      money: (cents) => String(cents),
      t,
    });
    const itemCents = doc.items.map((i) => Number(i.amount));
    expect(doc.items.map((i) => i.qty)).toEqual([4, 1]);
    expect(itemCents.reduce((a, b) => a + b, 0)).toBe(subtotalCents);
  });

  it("mismo plato con otro término son dos líneas, con el modificador y la nota colgados", () => {
    const doc = build({
      items: [
        { ...bretana, name: "Hamburguesa", priceCents: 2_800_000, modifiers: ["Término: Medio"] },
        {
          ...bretana,
          name: "Hamburguesa",
          priceCents: 2_800_000,
          modifiers: ["Término: Bien asado"],
          notes: "Sin cebolla",
        },
      ],
    });
    expect(doc.items).toEqual([
      { qty: 1, name: "Hamburguesa", amount: "$28000", modifiers: ["Término: Medio"] },
      {
        qty: 1,
        name: "Hamburguesa",
        amount: "$28000",
        modifiers: ["Término: Bien asado"],
        notes: "Sin cebolla",
      },
    ]);
  });

  it("un snapshot viejo (sin modificadores ni nota) no gana campos: el payload es el de siempre", () => {
    expect(build().items).toEqual([
      { qty: 2, name: "Bandeja paisa", amount: "$49000" },
      { qty: 1, name: "Limonada de coco", amount: "$12000" },
    ]);
  });
});
