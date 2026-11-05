// El descuento del cliente DENTRO de las líneas de la factura electrónica.
//
// Antes la factura de una cuenta con descuento declaraba el precio de
// lista: LineExtensionAmount, base e impuesto de más y un PayableAmount
// mayor que lo cobrado, sin ningún cac:AllowanceCharge. El Anexo Técnico
// (v1.8, FAQ01 pág. 77 y FBE01 págs. 95–96) dice que el descuento que baja
// la base se informa en el ítem; el del documento no la baja. Estos tests
// fijan el reparto (resto mayor, al centavo de lo cobrado), el XML de cada
// línea, los totales y los valores con los que se calcula el CUFE.
import { describe, expect, it } from "vitest";
import { computeDiscountCents } from "@/lib/dinerDiscount";
import { centsToDianAmount, computeCufe } from "./crypto";
import {
  allocateCents,
  discountInLinesOf,
  orderToInvoiceLines,
  saleLines,
  withDiscountInLines,
  type OrderItemForInvoice,
} from "./discountedLines";
import {
  LINE_DISCOUNT_REASON,
  buildDianInvoiceXml,
  type DianInvoiceInput,
  type DianLine,
  type DianParty,
} from "./ubl";

const supplier: DianParty = {
  name: "Restaurante de Prueba S.A.S.",
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
const IVA19 = { kind: "iva" as const, pct: 19 };

const item = (name: string, priceCents: number, over: Partial<OrderItemForInvoice> = {}): OrderItemForInvoice => ({
  nameSnapshot: name,
  qty: 1,
  priceCentsSnapshot: priceCents,
  cancelledAt: null,
  taxKind: null,
  taxPct: null,
  ...over,
});

/**
 * La forma del caso reportado (cifras inventadas, la misma estructura): una
 * cuenta de puro menú con INC 8 % incluido, subtotal $113.400, descuento del
 * cliente 20 % = $22.680 y propina $9.072 (va aparte, no a la factura).
 */
const MENU = [
  item("Bandeja paisa", 42_000_00),
  item("Ajiaco", 32_000_00),
  item("Limonada de coco", 12_000_00, { qty: 2 }),
  item("Café", 6_000_00, { qty: 2 }),
  item("Arepa de chócolo", 3_400_00),
];
const SUBTOTAL = 113_400_00;
const DISCOUNT = computeDiscountCents(SUBTOTAL, 20);

function input(lines: DianLine[]): DianInvoiceInput {
  return {
    environment: "2",
    softwareId: "soft-1",
    softwarePin: "1234",
    technicalKey: "clave-tecnica",
    resolution: { number: "18760000001", startDate: "2026-01-01", endDate: "2027-01-01", prefix: "FE", from: 1, to: 5000 },
    invoiceNumber: "FE10",
    issueDate: "2026-11-04",
    issueTime: "12:30:00-05:00",
    supplier,
    customer: consumidorFinal,
    lines,
    paymentMeansCode: "10",
  };
}

function legal(xml: string, tag: string): string {
  const block = xml.split("<cac:LegalMonetaryTotal>")[1]!.split("</cac:LegalMonetaryTotal>")[0]!;
  return block.match(new RegExp(`<cbc:${tag} currencyID="COP">([\\d.]+)<`))?.[1] ?? "";
}

function lineBlocks(xml: string): string[] {
  return xml.split("<cac:InvoiceLine>").slice(1).map((b) => b.split("</cac:InvoiceLine>")[0]!);
}

function amountIn(block: string, path: string): number {
  const m = block.match(new RegExp(`<cbc:${path} currencyID="COP">([\\d.]+)<`));
  return m ? Math.round(Number(m[1]) * 100) : NaN;
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const gross = (ls: readonly DianLine[]) => sum(ls.map((l) => l.lineTotalCents + l.taxCents));

describe("allocateCents — resto mayor, al centavo", () => {
  it("la suma es exactamente el total y ninguna parte supera su peso", () => {
    const weights = [1_005, 1_005, 1_005, 333, 7];
    for (const total of [0, 1, 2, 3, 100, 1_234, 3_355]) {
      const out = allocateCents(total, weights);
      expect(sum(out)).toBe(Math.min(total, sum(weights)));
      out.forEach((v, i) => expect(v).toBeLessThanOrEqual(weights[i]!));
    }
  });
  it("es determinista en los empates: mayor resto, después mayor peso, después el primero", () => {
    expect(allocateCents(1, [100, 100])).toEqual([1, 0]);
    expect(allocateCents(2, [300, 100, 200])).toEqual([1, 0, 1]);
  });
  it("no se pasa del total disponible ni con pesos enormes (sin perder centavos en un double)", () => {
    const out = allocateCents(2_000_000_000, [2_147_483_000, 1_000_000_001, 999]);
    expect(sum(out)).toBe(2_000_000_000);
  });
});

describe("el caso reportado: cuenta de menú con INC 8 % y descuento del 20 %", () => {
  const sale = saleLines(MENU, INC8, DISCOUNT);
  const built = buildDianInvoiceXml(input(sale.lines));

  it("cada línea neta = lo cobrado: la suma da el subtotal menos el descuento, exacto", () => {
    expect(DISCOUNT).toBe(22_680_00);
    expect(sale.discountCents).toBe(DISCOUNT);
    expect(gross(sale.lines)).toBe(SUBTOTAL - DISCOUNT);
  });

  it("los totales del documento declaran lo que se cobró, no la lista", () => {
    const { xml } = built;
    expect(legal(xml, "LineExtensionAmount")).toBe("84000.00");
    expect(legal(xml, "TaxExclusiveAmount")).toBe("84000.00");
    expect(legal(xml, "TaxInclusiveAmount")).toBe("90720.00");
    // FAU08: el del documento sólo suma descuentos de documento; los de
    // línea ya están dentro de LineExtensionAmount.
    expect(legal(xml, "AllowanceTotalAmount")).toBe("0.00");
    expect(legal(xml, "PayableAmount")).toBe("90720.00");
    expect(built.totals).toMatchObject({ taxIncCents: 6_720_00, taxIvaCents: 0, payableCents: 90_720_00 });
    // Antes: 105.000 / 113.400 con INC 8.400. La diferencia es el descuento.
    const before = buildDianInvoiceXml(input(orderToInvoiceLines(MENU, INC8))).totals;
    expect(before).toMatchObject({ lineExtensionCents: 105_000_00, taxIncCents: 8_400_00, payableCents: 113_400_00 });
    expect(sale.allowanceCents).toBe(21_000_00);
  });

  it("cada línea lleva su cac:AllowanceCharge (FBE01–FBE09) y LineExtensionAmount = base − descuento", () => {
    const blocks = lineBlocks(built.xml);
    expect(blocks).toHaveLength(MENU.length);
    for (const b of blocks) {
      const allowance = b.split("<cac:AllowanceCharge>")[1]!.split("</cac:AllowanceCharge>")[0]!;
      expect(allowance).toContain("<cbc:ID>1</cbc:ID>");
      expect(allowance).toContain("<cbc:ChargeIndicator>false</cbc:ChargeIndicator>");
      expect(allowance).toContain(`<cbc:AllowanceChargeReason>${LINE_DISCOUNT_REASON}</cbc:AllowanceChargeReason>`);
      // A nivel de ítem el descuento no se codifica (FBE01).
      expect(allowance).not.toContain("AllowanceChargeReasonCode");
      expect(allowance).toContain("<cbc:MultiplierFactorNumeric>20.00</cbc:MultiplierFactorNumeric>");
      const amount = amountIn(allowance, "Amount");
      const base = amountIn(allowance, "BaseAmount");
      const net = amountIn(b, "LineExtensionAmount");
      expect(net).toBe(base - amount);
      // La base del impuesto de la línea es el NETO (FAX05).
      expect(amountIn(b, "TaxableAmount")).toBe(net);
      // Orden del esquema: LineExtensionAmount, AllowanceCharge, TaxTotal, Item, Price.
      expect(b.indexOf("<cbc:LineExtensionAmount")).toBeLessThan(b.indexOf("<cac:AllowanceCharge>"));
      expect(b.indexOf("</cac:AllowanceCharge>")).toBeLessThan(b.indexOf("<cac:TaxTotal>"));
    }
    // No hay descuento a nivel de documento (no bajaría la base, FAQ01).
    const head = built.xml.split("<cac:InvoiceLine>")[0]!;
    expect(head).not.toContain("<cac:AllowanceCharge>");
  });

  it("el impuesto de cada línea es el reparto de siempre sobre el neto (splitTaxIncludedCents por línea)", () => {
    expect(sale.lines.map((l) => [l.lineTotalCents, l.taxCents])).toEqual([
      [3_111_111, 248_889],
      [2_370_370, 189_630],
      [1_777_778, 142_222],
      [888_889, 71_111],
      [251_852, 20_148],
    ]);
    // El precio unitario sigue siendo el de lista (FAV06: cantidad × precio − descuento).
    expect(sale.lines[2]!.unitPriceCents).toBe(1_111_111);
    expect(sale.lines[2]!.lineTotalCents + sale.lines[2]!.allowanceCents!).toBe(2 * 1_111_111);
    expect(sale.embedded).toEqual({ taxCents: 6_720_00, baseCents: 84_000_00, grossCents: 90_720_00 });
  });

  it("el CUFE sale de los valores NETOS: ValFac = LineExtensionAmount, ValImp INC, ValTot = PayableAmount", () => {
    const expected = computeCufe({
      invoiceNumber: "FE10",
      issueDate: "2026-11-04",
      issueTime: "12:30:00-05:00",
      lineExtensionAmount: "84000.00",
      taxIva: "0.00",
      taxInc: "6720.00",
      taxIca: "0.00",
      payableAmount: "90720.00",
      supplierNit: supplier.companyId,
      customerId: consumidorFinal.companyId,
      key: "clave-tecnica",
      environment: "2",
    });
    expect(built.cufe).toBe(expected);
  });
});

describe("reparto con varias líneas, tarifas y redondeo", () => {
  it("IVA 19 % en la carta con un descuento de 12,5 % (puntos base): el neto suma lo cobrado al centavo", () => {
    const items = [
      item("Plato A", 1_005),
      item("Plato B", 1_005),
      item("Plato C", 1_005, { qty: 3 }),
      item("Plato D", 33_333),
    ];
    const subtotal = sum(items.map((i) => i.priceCentsSnapshot * i.qty));
    const discount = computeDiscountCents(subtotal, 12.5);
    const sale = saleLines(items, IVA19, discount);
    expect(gross(sale.lines)).toBe(subtotal - discount);
    for (const l of sale.lines) {
      expect(l.taxSchemeId).toBe("01");
      // Impuesto coherente con la tarifa en cada línea (±1 centavo, el
      // redondeo de partir lo cobrado — igual que una línea sin descuento).
      expect(Math.abs(l.taxCents - Math.round(l.lineTotalCents * 0.19))).toBeLessThanOrEqual(1);
    }
    const { totals } = buildDianInvoiceXml(input(sale.lines));
    expect(totals.payableCents).toBe(subtotal - discount);
    expect(totals.taxIvaCents).toBe(sum(sale.lines.map((l) => l.taxCents)));
  });

  it("cuenta mixta: platos con INC, un servicio con IVA SUMADO y una línea libre sin impuesto", () => {
    const items = [
      item("Bandeja", 30_000_00),
      item("Postre", 9_000_00),
      item("Alquiler de sonido", 100_000_00, { taxKind: "iva", taxPct: 19 }),
      item("Decoración", 10_000_00, { taxKind: "none", taxPct: 0 }),
    ];
    // Lo que cobra MESAPAY: subtotal − descuento + IVA sumado encima.
    const subtotal = 149_000_00;
    const discount = computeDiscountCents(subtotal, 10);
    const taxOnTop = 19_000_00;
    const sale = saleLines(items, INC8, discount);
    expect(gross(sale.lines)).toBe(subtotal - discount + taxOnTop);
    // La línea con IVA encima queda tal como se cobró: su IVA es el del papel.
    const service = sale.lines.find((l) => l.description === "Alquiler de sonido")!;
    expect(service).toMatchObject({ lineTotalCents: 100_000_00, taxCents: 19_000_00, taxSchemeId: "01" });
    expect(service.allowanceCents).toBeUndefined();
    expect(sale.freeLineTax).toBeNull();
    // El descuento lo absorben los platos y la línea sin impuesto, en
    // proporción a lo que aportan al subtotal.
    const discounted = sale.lines.filter((l) => (l.allowanceCents ?? 0) > 0).map((l) => l.description);
    expect(discounted).toEqual(["Bandeja", "Postre", "Decoración"]);
    const { xml, totals } = buildDianInvoiceXml(input(sale.lines));
    expect(totals.payableCents).toBe(subtotal - discount + taxOnTop);
    expect(totals.taxIvaCents).toBe(19_000_00);
    expect(totals.taxIncCents).toBe(sum(sale.lines.filter((l) => l.taxSchemeId === "04").map((l) => l.taxCents)));
    // Un TaxTotal por impuesto en el documento; el descuento sigue fuera del pie.
    expect(legal(xml, "AllowanceTotalAmount")).toBe("0.00");
  });

  it("un descuento mayor que todos los platos: el resto lo absorbe la línea con IVA encima y el total sigue siendo lo cobrado", () => {
    const items = [item("Café", 5_000_00), item("Catering", 200_000_00, { taxKind: "iva", taxPct: 19 })];
    const subtotal = 205_000_00;
    const discount = computeDiscountCents(subtotal, 20);
    const sale = saleLines(items, INC8, discount);
    // El café quedó en cero: deja de ser una venta y no va a la factura.
    expect(sale.lines.map((l) => l.description)).toEqual(["Catering"]);
    expect(gross(sale.lines)).toBe(subtotal - discount + 38_000_00);
    const [catering] = sale.lines;
    expect(Math.abs(catering!.taxCents - Math.round(catering!.lineTotalCents * 0.19))).toBeLessThanOrEqual(1);
    expect(sale.freeLineTax).toEqual([{ kind: "iva", pct: 19, baseCents: catering!.lineTotalCents, taxCents: catering!.taxCents }]);
    expect(discountInLinesOf(sale)).toEqual({ allowanceCents: sale.allowanceCents, freeLineTax: sale.freeLineTax });
  });

  it("las líneas en $0 no van (como en #585) y no reciben descuento", () => {
    const items = [...MENU.slice(0, 2), item("Postre de cumpleaños", 0), ...MENU.slice(2)];
    const sale = saleLines(items, INC8, DISCOUNT);
    expect(sale.lines.map((l) => l.description)).not.toContain("Postre de cumpleaños");
    expect(sale.lines.map((l) => [l.lineTotalCents, l.taxCents])).toEqual(
      saleLines(MENU, INC8, DISCOUNT).lines.map((l) => [l.lineTotalCents, l.taxCents]),
    );
    const { xml } = buildDianInvoiceXml(input(sale.lines));
    expect(xml).toContain(`<cbc:LineCountNumeric>${MENU.length}</cbc:LineCountNumeric>`);
  });

  it("un descuento del 100 % deja la cuenta sin líneas que facturar", () => {
    expect(saleLines(MENU, INC8, SUBTOTAL).lines).toEqual([]);
  });

  it("comercio sin impuesto: el descuento baja la base y no hay impuesto que declarar", () => {
    const sale = saleLines(MENU, { kind: "none", pct: 0 }, DISCOUNT);
    expect(sale.lines.every((l) => l.taxCents === 0)).toBe(true);
    expect(sum(sale.lines.map((l) => l.lineTotalCents))).toBe(SUBTOTAL - DISCOUNT);
    expect(sale.allowanceCents).toBe(DISCOUNT);
  });
});

describe("sin descuento todo sigue igual", () => {
  it("las mismas líneas, sin AllowanceCharge, el mismo XML", () => {
    const plain = saleLines(MENU, INC8, 0);
    expect(plain.lines.every((l) => l.allowanceCents === undefined)).toBe(true);
    expect(plain.discountCents).toBe(0);
    expect(discountInLinesOf(plain)).toBeUndefined();
    const { xml } = buildDianInvoiceXml(input(plain.lines));
    expect(xml).not.toContain("AllowanceCharge>");
    expect(orderToInvoiceLines(MENU, INC8)).toEqual(plain.lines);
  });
});

describe("withDiscountInLines — snapshot de una factura vieja que se (re)envía", () => {
  const sale = saleLines(MENU, INC8, DISCOUNT);
  it("pasa el impuesto embebido a neto y deja la marca", () => {
    const old = { discountCents: DISCOUNT, embeddedTaxCents: 8_400_00, embeddedBaseCents: 105_000_00, subtotalCents: SUBTOTAL };
    expect(withDiscountInLines(old, sale)).toEqual({
      ...old,
      embeddedTaxCents: 6_720_00,
      embeddedBaseCents: 84_000_00,
      discountInLines: { allowanceCents: 21_000_00 },
    });
  });
  it("no toca una factura sin descuento ni una que ya lo declara", () => {
    expect(withDiscountInLines({ discountCents: 0 }, saleLines(MENU, INC8, 0))).toBeNull();
    expect(
      withDiscountInLines({ discountCents: DISCOUNT, discountInLines: { allowanceCents: 1 } }, sale),
    ).toBeNull();
  });
});

describe("montos del XML", () => {
  it("el descuento y su base van con dos decimales, en COP", () => {
    const [first] = lineBlocks(buildDianInvoiceXml(input(saleLines(MENU, INC8, DISCOUNT).lines)).xml);
    expect(first).toContain(`<cbc:Amount currencyID="COP">${centsToDianAmount(777_778)}</cbc:Amount>`);
    expect(first).toContain(`<cbc:BaseAmount currencyID="COP">${centsToDianAmount(3_888_889)}</cbc:BaseAmount>`);
  });
});
