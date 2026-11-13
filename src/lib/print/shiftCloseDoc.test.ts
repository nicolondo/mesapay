import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { readPaper, rowCapacity } from "@/lib/escpos/testPaper";
import { renderPrintJobPayload } from "@/lib/escpos/job";
import {
  REPORT_PAYLOAD_VERSION,
  parseReportPayload,
  renderReport,
  type ThermalReport,
} from "@/lib/escpos/report";
import { ThermalReportReceipt } from "@/components/print/ThermalReportReceipt";
import { buildShiftCloseTicket, shiftDurationLabel, type ShiftCloseReportData } from "./shiftCloseDoc";

/**
 * La TIRILLA del cierre de turno: el mismo documento por la impresora de
 * caja (ESC/POS) y por «Este dispositivo» (HTML a 58/80 mm). Se blinda:
 *
 *   · qué filas salen (resumen, por método, por mesero, arqueo, notas);
 *   · que en 58 mm ningún renglón se pase del ancho del papel;
 *   · el papel y el HTML (snapshots), para enterarse si algo cambia.
 */

/** El traductor devuelve la clave (con sus valores): lo que se prueba es QUÉ filas salen. */
const t = (key: string, values?: Record<string, string | number>) =>
  values ? `${key}(${Object.values(values).join("|")})` : key;
const money = (cents: number) => `$ ${Math.round(cents / 100).toLocaleString("en-US")}`;

const report: ShiftCloseReportData = {
  shift: {
    userLabel: null,
    openedAt: new Date("2026-11-13T15:00:00.000Z"),
    closedAt: new Date("2026-11-14T03:20:00.000Z"),
    openingCashCents: 20_000_000,
    declaredCashCents: 58_500_000,
    expectedCashCents: 58_700_000,
    cashDiffCents: -200_000,
    notes: "Faltaron 2.000 en monedas\nSe cambió el rollo de la caja",
  },
  totals: {
    grossCents: 152_340_000,
    tipCents: 12_340_000,
    tipReturns: [{ creditNoteId: "nc-1", documentNumber: "NC12", cents: 500_000 }],
    foodCents: 140_000_000,
    consumptionTaxCents: 10_370_370,
    taxPendingPayments: 1,
    paymentCount: 31,
    ordersClosed: 24,
  },
  byMethod: [
    { method: "cash", isCash: true, count: 12, grossCents: 38_700_000, tipCents: 2_000_000 },
    { method: "kushki_card_terminal", isCash: false, count: 19, grossCents: 113_640_000, tipCents: 10_340_000 },
  ],
  byWaiter: [
    {
      userId: "u1",
      userLabel: "Camila",
      count: 18,
      grossCents: 90_000_000,
      tipCents: 7_000_000,
      tipReturnedCents: 500_000,
      cashCents: 20_000_000,
    },
    {
      userId: null,
      userLabel: "Cliente",
      count: 13,
      grossCents: 62_340_000,
      tipCents: 5_340_000,
      tipReturnedCents: 0,
      cashCents: 18_700_000,
    },
  ],
  cash: { receivedCents: 38_700_000, changeGivenCents: 1_200_000 },
};

function build(paperWidthMm: number, over: Partial<ShiftCloseReportData> = {}): ThermalReport {
  return buildShiftCloseTicket({
    report: { ...report, ...over },
    paperWidthMm,
    merchant: "RESTAURANTE DE MUESTRA SAS",
    taxId: "900000001",
    businessDate: "2026-11-13",
    dateTime: (d) => d.toISOString().slice(0, 16).replace("T", " "),
    durationLabel: "12h 20m",
    generatedLabel: "reportGenerated",
    money,
    methodLabel: (m) => (m === "cash" ? "Efectivo" : "Datáfono (Kushki)"),
    t,
    tTips: t,
  });
}

describe("buildShiftCloseTicket — qué sale en la tirilla", () => {
  it("encabezado: comercio, NIT, título y los datos del turno", () => {
    const doc = build(58);
    expect(doc.businessName).toBe("RESTAURANTE DE MUESTRA SAS");
    expect(doc.businessLines).toEqual(["taxId(900000001)"]);
    expect(doc.title).toBe("SHIFTCLOSE");
    expect(doc.metaRows.map((r) => r.label)).toEqual([
      "businessDay",
      "fieldOpened",
      "fieldClosed",
      "fieldDuration",
      "fieldShiftOf",
    ]);
    expect(doc.metaRows[4].value).toBe("shiftOfGlobal");
  });

  it("resumen: ventas (fuerte), comida, propinas, devueltas y netas, INC y el aviso de cobros sin desglose", () => {
    const [summary] = build(58).sections;
    expect(summary.title).toBe("summary");
    expect(summary.rows).toEqual([
      { label: "grossSales", value: "$ 1,523,400", strong: true },
      { label: "foodNoTip", value: "$ 1,400,000" },
      { label: "tips", value: "$ 123,400" },
      { label: "line(NC12)", value: "-$ 5,000" },
      { label: "net", value: "$ 118,400" },
      { label: "consumptionTax", value: "$ 103,704" },
      { label: "paymentsOrders", value: "31 · 24" },
    ]);
    expect(summary.notes).toEqual(["consumptionTaxIncluded", "consumptionTaxPending(1)"]);
  });

  it("por método de pago (con cuántos pagos) y el total", () => {
    const methods = build(58).sections[1];
    expect(methods.rows).toEqual([
      { label: "Efectivo (12)", value: "$ 387,000" },
      { label: "Datáfono (Kushki) (19)", value: "$ 1,136,400" },
      { label: "total", value: "$ 1,523,400", strong: true },
    ]);
  });

  it("sin pagos: el aviso, y sin sección de meseros", () => {
    const doc = build(58, { byMethod: [], byWaiter: [] });
    expect(doc.sections[1]).toEqual({ title: "byMethodTitle", rows: [], notes: ["noPayments"] });
    expect(doc.sections.map((s) => s.title)).toEqual(["summary", "byMethodTitle", "cashAndCount"]);
  });

  it("por mesero: lo cobrado y, debajo, su efectivo, su propina y lo devuelto", () => {
    const waiters = build(58).sections[2];
    expect(waiters.title).toBe("byWaiterTitle");
    expect(waiters.rows.slice(0, 4)).toEqual([
      { label: "Camila (18)", value: "$ 900,000" },
      { label: "· thCash", value: "$ 200,000" },
      { label: "· thTip", value: "$ 70,000" },
      { label: "", value: "waiterReturned($ 5,000)" },
    ]);
  });

  it("arqueo: la diferencia con signo y en fuerte; las notas renglón por renglón", () => {
    const cash = build(58).sections[3];
    expect(cash.rows.at(-1)).toEqual({ label: "difference", value: "-$ 2,000", strong: true });
    expect(cash.notes).toEqual(["notes:", "Faltaron 2.000 en monedas", "Se cambió el rollo de la caja"]);
    const even = build(58, { shift: { ...report.shift, cashDiffCents: 0, notes: null } }).sections[3];
    expect(even.rows.at(-1)?.value).toBe("$ 0");
    expect(even.notes).toEqual([]);
  });

  it("duración como la pantalla", () => {
    expect(shiftDurationLabel(0, t)).toBe("emptyDash");
    expect(shiftDurationLabel(45 * 60_000, t)).toBe("durationM(45)");
    expect(shiftDurationLabel((3 * 60 + 20) * 60_000, t)).toBe("durationHm(3|20)");
  });
});

describe("por la impresora de caja (ESC/POS)", () => {
  it("el sobre sobrevive al ida y vuelta por la DB y el agente lo imprime", () => {
    const doc = build(80);
    const payload = JSON.parse(JSON.stringify({ v: REPORT_PAYLOAD_VERSION, report: doc }));
    expect(parseReportPayload(payload)).toEqual(doc);
    expect(renderPrintJobPayload(payload)?.equals(renderReport(doc))).toBe(true);
  });

  it("un sobre roto no se imprime (se cierra en fallido)", () => {
    for (const raw of [null, {}, { v: 2, report: build(58) }, { v: 1, report: { title: "x" } }]) {
      expect(parseReportPayload(raw)).toBeNull();
    }
  });

  it("en 58 mm ningún renglón se pasa del papel", () => {
    const paper = readPaper(renderReport(build(58)));
    for (const row of paper.rows) {
      expect(row.text.length).toBeLessThanOrEqual(rowCapacity(row, 58));
    }
  });

  it("el papel de 58 mm, como se ve impreso", () => {
    expect(readPaper(renderReport(build(58))).text).toMatchSnapshot();
  });
});

describe("en «Este dispositivo» (la vista del navegador)", () => {
  it("es el MISMO documento, al ancho del papel del equipo, listo para imprimir en una tira", () => {
    const html = renderToStaticMarkup(
      createElement(ThermalReportReceipt, { doc: build(58), paperMm: 58, kind: "cierre" }),
    );
    expect(html).toContain('data-print-document="cierre"');
    expect(html).toContain('data-print-width-mm="58"');
    expect(html).toContain("width:58mm");
    expect(html).toMatchSnapshot();
  });
});
