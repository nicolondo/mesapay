import { describe, expect, it } from "vitest";
import { getEmailTranslator } from "@/lib/emailIntl";
import { formatMoney } from "@/lib/format";
import { groupInvoiceLines } from "@/lib/invoiceLines";
import { buildThermalInvoice } from "@/lib/print/invoiceDoc";
import type { PrebillData } from "@/lib/prebill";
import { qr } from "./commands";
import { itemChunks, itemDetail, totalRowChunks } from "./compact";
import { renderInvoice, type ThermalInvoice } from "./invoice";
import { buildPrebillTicket, renderPrebill } from "./prebill";
import { readPaper } from "./testPaper";
import {
  LONG_INVOICE_CUFE as CUFE,
  LONG_INVOICE_SNAPSHOT as S,
  LONG_INVOICE_VERIFY_URL as VERIFY,
} from "./longInvoice.fixture";

/**
 * El formato COMPACTO, medido. El dueño: "quiero que el formato optimice
 * espacio vertical lo que más se pueda". Una factura electrónica de ~40
 * platos (la de la foto) se imprime con los catálogos REALES y se cuenta
 * el papel: renglones y alto estimado.
 *
 * Los números de ANTES son los del renderer anterior (origin/main antes
 * de este cambio) con esta MISMA factura, medidos con el mismo lector
 * (`readPaper`). Quedan fijos acá como referencia: si alguien vuelve a
 * soltar el formato, el test lo canta.
 */
const BEFORE = {
  invoice80Qr: { lines: 114, heightDots: 3474 },
  invoice80Text: { lines: 117, heightDots: 3564 },
  invoice58Qr: { lines: 153, heightDots: 4644 },
  prebill80: { lines: 124, heightDots: 3774 },
  prebill58: { lines: 159, heightDots: 4824 },
};

const money = (c: number) => formatMoney(c, { currency: "COP", locale: "es" });
/**
 * El papel como un solo párrafo: sin saltos (un dato largo puede quedar
 * partido en dos renglones) y con los espacios duros del formateador de
 * moneda como espacios comunes (CP850 los imprime igual).
 */
const flat = (text: string) => text.replace(/\n/g, " ").replace(/\u00a0/g, " ");

async function invoice(paperWidthMm: number, withQr: boolean): Promise<ThermalInvoice> {
  const { t } = await getEmailTranslator("es", "emailInvoice");
  return buildThermalInvoice({
    snapshot: S,
    invoiceNumber: 1234,
    paperWidthMm,
    paidAtLabel: "24/09/26, 9:41 p. m.",
    dianResolutionDateLabel: "15/01/26",
    // Un pago por la cuenta entera: amountCents lleva la propina adentro.
    payments: [{ method: "cash", amountCents: S.totalCents, tipCents: S.tipCents }],
    money,
    t: (k, v) => t(k, v) as string,
    dian: { cufe: CUFE, verifyUrl: VERIFY, qr: withQr },
  });
}

async function prebill(paperWidthMm: number) {
  const { t } = await getEmailTranslator("es", "emailInvoice");
  const lines = groupInvoiceLines(S.items).map((l) => ({
    qty: l.qty,
    name: l.name,
    unitCents: l.priceCents,
    lineCents: l.totalCents,
    modifiers: l.modifiers ?? [],
    notes: l.notes ?? null,
    guestName: null,
  }));
  const data: PrebillData = {
    businessName: "SON Y MELONA S.A.S.",
    taxId: "901.234.567-8",
    legalAddress: "Carrera 43A # 1-50, local 102",
    legalCity: "Medellín",
    legalPhone: "604 444 5566",
    shortCode: S.shortCode,
    destination: { kind: "table", number: 12, label: null },
    waiterName: "Carlos",
    issuedAt: new Date(S.paidAtIso),
    lines,
    grossSubtotalCents: S.subtotalCents,
    discountPct: null,
    discountCents: 0,
    netSubtotalCents: S.subtotalCents,
    embeddedTax: {
      kind: "inc",
      pct: 8,
      taxCents: S.embeddedTaxCents!,
      baseCents: S.embeddedBaseCents!,
    },
    taxOnTop: { inc: 0, iva: 0 },
    taxOnTopCents: 0,
    totalCents: S.subtotalCents,
    paidCents: 0,
    outstandingCents: S.subtotalCents,
    suggestedTipPct: 10,
    suggestedTipCents: S.tipCents,
    totalWithTipCents: S.subtotalCents + S.tipCents,
  };
  return buildPrebillTicket({
    data,
    paperWidthMm,
    dateLabel: "24/09/26, 21:41",
    money,
    t: (k, v) => t(k, v) as string,
  });
}

const pct = (before: number, after: number) =>
  Math.round(((before - after) / before) * 1000) / 10;

describe("factura de ~40 platos — cuánto papel gasta", () => {
  it("80mm con QR: menos renglones y bastante menos alto que antes", async () => {
    const paper = readPaper(renderInvoice(await invoice(80, true)));
    const b = BEFORE.invoice80Qr;
    console.log(
      `[compacto] factura 80mm con QR: ${b.lines} → ${paper.lines} renglones ` +
        `(-${pct(b.lines, paper.lines)}%), alto ${b.heightDots} → ${paper.heightDots} puntos ` +
        `(-${pct(b.heightDots, paper.heightDots)}%)`,
    );
    expect(paper.lines).toBeLessThanOrEqual(Math.floor(b.lines * 0.85));
    expect(paper.heightDots).toBeLessThanOrEqual(Math.floor(b.heightDots * 0.75));
  });

  it("80mm sin QR (URL en texto) y 58mm con QR también bajan", async () => {
    for (const [key, mm, withQr] of [
      ["invoice80Text", 80, false],
      ["invoice58Qr", 58, true],
    ] as const) {
      const paper = readPaper(renderInvoice(await invoice(mm, withQr)));
      const b = BEFORE[key];
      console.log(
        `[compacto] ${key}: ${b.lines} → ${paper.lines} renglones (-${pct(b.lines, paper.lines)}%), ` +
          `alto -${pct(b.heightDots, paper.heightDots)}%`,
      );
      expect(paper.lines).toBeLessThan(b.lines);
      expect(paper.heightDots).toBeLessThanOrEqual(Math.floor(b.heightDots * 0.8));
    }
  });

  it("la precuenta de la misma cuenta también baja, en 80 y 58mm", async () => {
    for (const [key, mm] of [
      ["prebill80", 80],
      ["prebill58", 58],
    ] as const) {
      const paper = readPaper(renderPrebill(await prebill(mm)));
      const b = BEFORE[key];
      console.log(
        `[compacto] ${key}: ${b.lines} → ${paper.lines} renglones (-${pct(b.lines, paper.lines)}%), ` +
          `alto -${pct(b.heightDots, paper.heightDots)}%`,
      );
      expect(paper.lines).toBeLessThan(b.lines);
      expect(paper.heightDots).toBeLessThanOrEqual(Math.floor(b.heightDots * 0.8));
    }
  });
});

describe("factura compacta — no se pierde nada obligatorio", () => {
  it("rótulo, prefijo y número, fecha, NIT, resolución, CUFE, leyendas y QR", async () => {
    const inv = await invoice(80, true);
    const bytes = renderInvoice(inv);
    const text = flat(readPaper(bytes).text);
    expect(text).toContain("FACTURA ELECTRÓNICA DE VENTA");
    expect(text).toContain("SM1234");
    expect(text).toContain("24/09/26, 9:41 p. m.");
    expect(text).toContain("NIT 901.234.567-8");
    expect(text).toContain("Carrera 43A # 1-50, local 102");
    expect(text).toContain("Cliente: Consumidor final");
    expect(text).toContain("Resolución DIAN: 18764000012345");
    expect(text).toContain("Numeración del 1 al 100000");
    expect(text).toContain("Fecha de resolución 15/01/26");
    expect(text).toContain("Representación impresa de la factura electrónica de venta");
    expect(text).toContain("ADVERTENCIA DE PROPINA");
    // El CUFE entero, aunque vaya partido en renglones con su rótulo.
    expect(readPaper(bytes).text.replace(/\n/g, "")).toContain(`CUFE: ${CUFE}`);
    expect(bytes.includes(qr(VERIFY, { size: 4, correction: "M" }))).toBe(true);
  });

  it("impuesto discriminado y los totales cuadran al centavo con los ítems", async () => {
    const inv = await invoice(80, true);
    const text = flat(readPaper(renderInvoice(inv)).text);
    const m = (c: number) => flat(money(c));
    for (const label of ["Subtotal", "Base gravable", "Incl. impoconsumo 8%", "Propina", "TOTAL"]) {
      expect(text).toContain(label);
    }
    // Los ítems agrupados suman EXACTAMENTE el subtotal.
    const grouped = groupInvoiceLines(S.items);
    expect(grouped.reduce((s, l) => s + l.totalCents, 0)).toBe(S.subtotalCents);
    expect(grouped).toHaveLength(40);
    // Y todos salen con su importe.
    for (const l of grouped) expect(text).toContain(m(l.totalCents));
    expect(text).toContain(m(S.subtotalCents));
    expect(text).toContain(m(S.embeddedBaseCents!));
    expect(text).toContain(m(S.embeddedTaxCents!));
    expect(text).toContain(m(S.tipCents));
    expect(text).toContain(m(S.totalCents));
    expect(S.embeddedBaseCents! + S.embeddedTaxCents!).toBe(S.subtotalCents);
  });

  it("sin QR sale la URL de consulta completa en texto", async () => {
    const text = readPaper(renderInvoice(await invoice(80, false))).text;
    expect(text).toContain("Consulta esta factura en la DIAN:");
    expect(text.replace(/\n/g, "")).toContain(VERIFY);
  });

  it("ningún renglón se pasa del ancho de su fuente (A: 48/32, B: 64/42)", async () => {
    for (const mm of [80, 58]) {
      const paper = readPaper(renderInvoice(await invoice(mm, false))).text;
      const max = mm === 80 ? 64 : 42;
      for (const l of paper.split("\n")) expect(l.length).toBeLessThanOrEqual(max);
    }
  });
});

describe("piezas del formato compacto", () => {
  it("modificadores y nota van en UN texto con ' · ' y la nota entre comillas", () => {
    expect(itemDetail(["Término: 1/2", "Guarniciones: Ensalada fresca"], "sin cebolla")).toBe(
      'Término: 1/2 · Guarniciones: Ensalada fresca · "sin cebolla"',
    );
    expect(itemDetail([], null)).toBe("");
    expect(itemDetail(undefined, "  ")).toBe("");
    expect(itemDetail(["  "], null, ["2 x $ 10.000"])).toBe("2 x $ 10.000");
  });

  it("el detalle del plato va en fuente B (ESC M 1) y vuelve a la A", () => {
    const b = Buffer.concat(
      itemChunks(
        { qty: 1, name: "Hamburguesa", amount: "$ 36.000", detail: "Término: 1/2" },
        48,
        64,
      ),
    );
    expect(b.toString("hex")).toContain("1b4d01");
    expect(b.subarray(-3).toString("hex")).toBe("1b4d00");
    expect(readPaper(b).text).toBe(
      "1x Hamburguesa                          $ 36.000\n    Término: 1/2\n",
    );
  });

  it("el TOTAL va a doble ANCHO (GS ! 0x10, sin doble alto) cuando entra en media línea", () => {
    const b = Buffer.concat(totalRowChunks({ label: "TOTAL", amount: "$ 61.000", strong: true }, 48));
    expect(b.toString("hex")).toContain("1d2110");
    expect(b.toString("hex")).not.toContain("1d2111");
    expect(readPaper(b).text).toBe("TOTAL           $ 61.000\n");
  });

  it("un TOTAL que no entra a doble ancho va en negrita a tamaño normal, en un renglón", () => {
    const b = Buffer.concat(
      totalRowChunks({ label: "TOTAL", amount: "$ 12.345.678", strong: true }, 32),
    );
    expect(b.toString("hex")).not.toContain("1d21");
    expect(readPaper(b).lines).toBe(1);
  });
});
