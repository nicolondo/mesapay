import { describe, expect, it } from "vitest";
import { getEmailTranslator } from "@/lib/emailIntl";
import { formatMoney } from "@/lib/format";
import type { InvoiceSnapshot } from "@/lib/invoice";
import { buildThermalInvoice } from "@/lib/print/invoiceDoc";
import { TOP_MARGIN_DOTS } from "./commands";
import { renderInvoice, type ThermalInvoice } from "./invoice";
import {
  LONG_INVOICE_CUFE as CUFE,
  LONG_INVOICE_SNAPSHOT as LONG,
  LONG_INVOICE_VERIFY_URL as VERIFY,
} from "./longInvoice.fixture";
import { renderPrebill, type ThermalPrebill } from "./prebill";
import { printableDots, readPaper, rowCapacity, type Paper } from "./testPaper";

/**
 * INVARIANTES del papel, sobre el stream ESC/POS completo de la factura y
 * la precuenta, en 80 y 58 mm, con y sin QR.
 *
 * Nacen de la foto de la factura electrónica FESM6723 de Son y Melona:
 * el nombre del comercio salió con sólo la mitad de abajo y el TOTAL se
 * encimó con las filas de al lado. Lo que la térmica hace mal no se ve en
 * un snapshot de bytes; estas reglas sí:
 *
 *   1. ningún renglón avanza con un interlineado menor que su letra más
 *      alta (a doble alto, 48 puntos): hay térmicas que recortan la letra
 *      a la franja del interlineado;
 *   2. ningún renglón ocupa más que el ancho imprimible, contado con las
 *      columnas EFECTIVAS de su tamaño (a doble ancho, la mitad): la
 *      térmica no envuelve, trunca o se come el renglón de al lado;
 *   3. antes del primer renglón hay un margen superior.
 */

const money = (c: number) => formatMoney(c, { currency: "COP", locale: "es" });

/** Espacio duro del formateador → espacio común (CP850 los imprime igual). */
const flat = (s: string) => s.replace(/ /g, " ");

function assertInvariants(bytes: Buffer, paperWidthMm: number): Paper {
  const paper = readPaper(bytes);
  for (const row of paper.rows) {
    const where = `"${row.text}" (${paperWidthMm} mm)`;
    // 1. Interlineado ≥ alto de la letra.
    expect(row.spacingDots, `interlineado de ${where}`).toBeGreaterThanOrEqual(
      row.charHeightDots,
    );
    // 2. Ancho: en columnas de su tamaño y en puntos del papel.
    expect(row.text.length, `columnas de ${where}`).toBeLessThanOrEqual(
      rowCapacity(row, paperWidthMm),
    );
    expect(row.widthDots, `ancho de ${where}`).toBeLessThanOrEqual(
      printableDots(paperWidthMm),
    );
  }
  // 3. Margen superior: un ESC J de al menos TOP_MARGIN_DOTS antes del
  // primer carácter impreso (el primer byte que no es de un comando).
  const escJ = bytes.indexOf(Buffer.from([0x1b, 0x4a]));
  expect(escJ).toBeGreaterThan(0);
  expect(bytes[escJ + 2]).toBeGreaterThanOrEqual(TOP_MARGIN_DOTS);
  const firstRow = paper.rows.find((r) => r.text.trim().length > 0)!;
  expect(bytes.indexOf(Buffer.from(firstRow.text.trim().slice(0, 6), "latin1"))).toBeGreaterThan(
    escJ,
  );
  return paper;
}

/** Hay al menos un renglón a doble alto: si no, la regla 1 no probó nada. */
function tallRows(paper: Paper) {
  return paper.rows.filter((r) => r.heightMul > 1);
}

// ── Factura ──────────────────────────────────────────────────────────────

/**
 * La FESM6723 tal como está en producción (orden cmuj1w9c60069g2jhjox90kjc):
 * subtotal $159.600 con impoconsumo 8% incluido, propina $15.960, total
 * $175.560 y UN pago en efectivo con amountCents 17556000 (propina
 * incluida) y tipCents 1596000.
 */
const FESM6723: InvoiceSnapshot = {
  ...LONG,
  items: [
    { qty: 2, name: "Hamburguesa Melona con tocineta y queso", priceCents: 3_600_000 },
    { qty: 1, name: "Churrasco a la parrilla con chimichurri de la casa", priceCents: 5_800_000 },
    { qty: 1, name: "Limonada de coco", priceCents: 1_200_000 },
    { qty: 1, name: "Cerveza Club Colombia dorada", priceCents: 900_000 },
    { qty: 1, name: "Brownie con helado de vainilla", priceCents: 860_000 },
  ],
  subtotalCents: 15_960_000,
  embeddedTaxCents: 1_182_222,
  embeddedBaseCents: 14_777_778,
  tipCents: 1_596_000,
  totalCents: 17_556_000,
};
const FESM6723_PAYMENT = { method: "cash", amountCents: 17_556_000, tipCents: 1_596_000 };

type InvoiceCase = {
  name: string;
  snapshot: InvoiceSnapshot;
  /** null = comprobante; si no, factura electrónica con o sin QR. */
  qr: boolean | null;
};

const INVOICE_CASES: InvoiceCase[] = [
  { name: "FESM6723 comprobante", snapshot: FESM6723, qr: null },
  { name: "FESM6723 electrónica sin QR", snapshot: FESM6723, qr: false },
  { name: "FESM6723 electrónica con QR", snapshot: FESM6723, qr: true },
  { name: "40 platos con QR", snapshot: LONG, qr: true },
  {
    // Lo que más estira los renglones: razón social larga, cliente con
    // dirección, descuento y un total de diez cifras que en 58 mm no
    // entra al lado del rótulo.
    name: "extremos",
    snapshot: {
      ...FESM6723,
      legalName: "INVERSIONES GASTRONÓMICAS DEL CARIBE Y EL PACÍFICO S.A.S.",
      discountCents: 1_234_567,
      discountPct: 7,
      subtotalCents: 123_456_789_000,
      embeddedTaxCents: 9_145_000_000,
      embeddedBaseCents: 114_311_789_000,
      tipCents: 12_345_678_900,
      totalCents: 135_801_233_333,
      customer: {
        name: "Distribuidora de Alimentos Ñandú y Compañía Limitada",
        docType: "NIT",
        docNumber: "900.987.654-3",
        address: "Carrera 43A # 1-50, Torre Empresarial, oficina 1502",
        city: "Medellín",
        department: "Antioquia",
      },
    },
    qr: true,
  },
];

async function invoiceDoc(c: InvoiceCase, paperWidthMm: number): Promise<ThermalInvoice> {
  const { t } = await getEmailTranslator("es", "emailInvoice");
  return buildThermalInvoice({
    snapshot: c.snapshot,
    invoiceNumber: 6723,
    paperWidthMm,
    paidAtLabel: "26/09/26, 9:10 p. m.",
    dianResolutionDateLabel: "15/01/26",
    payments: [{ ...FESM6723_PAYMENT, amountCents: c.snapshot.totalCents }],
    money,
    t: (k, v) => t(k, v) as string,
    dian: c.qr === null ? null : { cufe: CUFE, verifyUrl: VERIFY, qr: c.qr },
  });
}

describe("factura — invariantes del papel", () => {
  for (const c of INVOICE_CASES) {
    for (const mm of [80, 58]) {
      it(`${c.name}, ${mm} mm`, async () => {
        const paper = assertInvariants(renderInvoice(await invoiceDoc(c, mm)), mm);
        // El TOTAL es el renglón a doble alto, y avanza 48 puntos.
        const tall = tallRows(paper);
        expect(tall.length).toBeGreaterThan(0);
        expect(tall.some((r) => r.text.startsWith("TOTAL"))).toBe(true);
        for (const r of tall) expect(r.spacingDots).toBeGreaterThanOrEqual(48);
      });
    }
  }
});

describe("FESM6723 de punta a punta — del pago real al papel", () => {
  for (const mm of [80, 58]) {
    it(`la forma de pago dice el TOTAL ($ 175.560), no $ 191.520 (${mm} mm)`, async () => {
      const { t } = await getEmailTranslator("es", "emailInvoice");
      const doc = buildThermalInvoice({
        snapshot: FESM6723,
        invoiceNumber: 6723,
        paperWidthMm: mm,
        paidAtLabel: "26/09/26, 9:10 p. m.",
        dianResolutionDateLabel: "15/01/26",
        payments: [FESM6723_PAYMENT],
        money,
        t: (k, v) => t(k, v) as string,
        dian: { cufe: CUFE, verifyUrl: VERIFY, qr: true },
      });
      const text = flat(readPaper(renderInvoice(doc)).text);
      expect(text).not.toContain("191.520");
      const total = doc.totals.find((r) => r.strong)!;
      expect(flat(total.amount)).toBe("$ 175.560");
      expect(doc.paymentRows).toHaveLength(1);
      expect(doc.paymentRows[0].amount).toBe(total.amount);
      // En el papel: el renglón del pago termina en el mismo monto.
      const payLine = text.split("\n").find((l) => l.includes("Efectivo"))!;
      expect(payLine.endsWith("$ 175.560")).toBe(true);
    });
  }
});

// ── Precuenta ────────────────────────────────────────────────────────────

const PREBILL: ThermalPrebill = {
  paperWidthMm: 80,
  businessName: "SON Y MELONA S.A.S.",
  businessLines: ["NIT 901.234.567-8", "Carrera 43A # 1-50, local 102", "Medellín"],
  title: "PRECUENTA",
  notInvoiceLine: "Este documento no es una factura",
  metaRows: [
    { label: "Fecha", value: "26/09/26, 21:05" },
    { label: "Mesa 12", value: "002A77" },
    { label: "Mesero", value: "Carlos" },
  ],
  items: [
    {
      qty: 2,
      name: "Hamburguesa Melona con tocineta y queso",
      amount: "$ 72.000",
      unit: "$ 36.000",
      modifiers: ["Término: 1/2", "Guarniciones: Ensalada fresca"],
      notes: "sin cebolla",
    },
    {
      qty: 1,
      name: "Churrasco a la parrilla con chimichurri de la casa",
      amount: "$ 58.000",
      unit: null,
      modifiers: [],
      notes: null,
    },
  ],
  totals: [
    { label: "Subtotal", amount: "$ 159.600" },
    { label: "Base gravable", amount: "$ 147.778" },
    { label: "Incl. impoconsumo 8%", amount: "$ 11.822" },
    { label: "TOTAL", amount: "$ 159.600", strong: true },
    { label: "Pagado", amount: "-$ 50.000" },
    { label: "Pendiente por pagar", amount: "$ 109.600", strong: true },
  ],
  tipRows: [
    { label: "Propina sugerida 10%", amount: "$ 10.960" },
    { label: "Total con propina", amount: "$ 120.560" },
  ],
  tipNotice: "La propina es voluntaria: podés aceptarla, rechazarla o cambiarla.",
  footerLines: ["¡Gracias por tu visita!"],
};

const PREBILL_CASES: Array<{ name: string; doc: ThermalPrebill }> = [
  { name: "con pago parcial y propina sugerida", doc: PREBILL },
  {
    name: "montos de diez cifras",
    doc: {
      ...PREBILL,
      totals: [
        { label: "Subtotal", amount: "$ 1.234.567.890" },
        { label: "TOTAL", amount: "$ 1.234.567.890", strong: true },
        { label: "Pendiente por pagar", amount: "$ 1.234.567.890", strong: true },
      ],
    },
  },
];

describe("precuenta — invariantes del papel", () => {
  for (const c of PREBILL_CASES) {
    for (const mm of [80, 58]) {
      it(`${c.name}, ${mm} mm`, () => {
        const paper = assertInvariants(renderPrebill({ ...c.doc, paperWidthMm: mm }), mm);
        // TOTAL y PENDIENTE a doble alto; PRECUENTA a doble ancho en la
        // mitad de las columnas.
        const tall = tallRows(paper);
        expect(tall.some((r) => r.text.startsWith("TOTAL"))).toBe(true);
        expect(tall.some((r) => r.text.startsWith("Pendiente"))).toBe(true);
        const title = paper.rows.find((r) => r.text === "PRECUENTA")!;
        expect(title.widthMul).toBe(2);
        expect(title.text.length).toBeLessThanOrEqual(mm >= 80 ? 24 : 16);
      });
    }
  }
});
