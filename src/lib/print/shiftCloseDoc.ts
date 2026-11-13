/**
 * La TIRILLA del cierre de turno: del reporte contable (`buildShiftReport`)
 * al documento térmico (`ThermalReport`) que imprimen igual la impresora
 * de caja (por el agente, ESC/POS) y la de «Este dispositivo» (la vista
 * `/operator/shifts/[id]/tirilla` en el navegador del equipo).
 *
 * Es el RESUMEN que se arranca al cerrar la caja: ventas, impuesto,
 * propinas, por método de pago, por mesero y el arqueo del efectivo. La
 * lista pago por pago no entra (en un turno normal serían metros de
 * papel): sigue en el reporte completo de la pantalla del turno, que se
 * imprime en hoja con «Imprimir reporte completo».
 *
 * Puro: textos, montos y fechas entran ya resueltos por parámetro, para
 * probarlo sin catálogos ni DB. Las etiquetas son las MISMAS del reporte
 * de la pantalla (namespace `opShifts` y `tipReturns`).
 */

import type { ShiftReport } from "@/lib/shiftReport";
import type { ThermalReport, ThermalReportRow, ThermalReportSection } from "@/lib/escpos/report";

export type ShiftCloseTranslator = (key: string, values?: Record<string, string | number>) => string;

/** Lo del reporte que sale en la tirilla (sin la lista de pagos). */
export type ShiftCloseReportData = {
  shift: Pick<
    ShiftReport["shift"],
    | "userLabel"
    | "openedAt"
    | "closedAt"
    | "openingCashCents"
    | "declaredCashCents"
    | "expectedCashCents"
    | "cashDiffCents"
    | "notes"
  >;
  totals: Pick<
    ShiftReport["totals"],
    | "grossCents"
    | "tipCents"
    | "tipReturns"
    | "foodCents"
    | "consumptionTaxCents"
    | "taxPendingPayments"
    | "paymentCount"
    | "ordersClosed"
  >;
  byMethod: ShiftReport["byMethod"];
  byWaiter: ShiftReport["byWaiter"];
  cash: Pick<ShiftReport["cash"], "receivedCents" | "changeGivenCents">;
};

export function buildShiftCloseTicket(args: {
  report: ShiftCloseReportData;
  paperWidthMm: number;
  merchant: string;
  taxId: string | null;
  /** La jornada (día de negocio) del turno, como la muestra la pantalla. */
  businessDate: string;
  /** Fecha y hora ya escritas ("13/11/26 · 21:40"). */
  dateTime: (d: Date) => string;
  /** "3h 20m", ya escrito. */
  durationLabel: string;
  /** "Reporte generado el …", ya escrito. */
  generatedLabel: string;
  money: (cents: number) => string;
  methodLabel: (method: string) => string;
  /** Namespace `opShifts`. */
  t: ShiftCloseTranslator;
  /** Namespace `tipReturns`. */
  tTips: ShiftCloseTranslator;
}): ThermalReport {
  const { report: r, money, t, tTips } = args;
  const dash = t("emptyDash");

  const metaRows: ThermalReportRow[] = [
    { label: t("businessDay"), value: args.businessDate },
    { label: t("fieldOpened"), value: args.dateTime(r.shift.openedAt) },
    { label: t("fieldClosed"), value: r.shift.closedAt ? args.dateTime(r.shift.closedAt) : dash },
    { label: t("fieldDuration"), value: args.durationLabel },
    { label: t("fieldShiftOf"), value: r.shift.userLabel ?? t("shiftOfGlobal") },
  ];

  // ── Resumen ─────────────────────────────────────────────────────────
  const summaryRows: ThermalReportRow[] = [
    { label: t("grossSales"), value: money(r.totals.grossCents), strong: true },
    { label: t("foodNoTip"), value: money(r.totals.foodCents) },
    { label: t("tips"), value: money(r.totals.tipCents) },
  ];
  // Propinas devueltas por anulación: bajan lo que se le debe al equipo.
  if (r.totals.tipReturns.length > 0) {
    for (const l of r.totals.tipReturns) {
      summaryRows.push({ label: tTips("line", { number: l.documentNumber }), value: "-" + money(l.cents) });
    }
    const net = r.totals.tipCents - r.totals.tipReturns.reduce((s, l) => s + l.cents, 0);
    summaryRows.push({ label: tTips("net"), value: (net < 0 ? "-" : "") + money(Math.abs(net)) });
  }
  summaryRows.push(
    { label: t("consumptionTax"), value: money(r.totals.consumptionTaxCents) },
    {
      label: t("paymentsOrders"),
      value: `${r.totals.paymentCount} · ${r.totals.ordersClosed}`,
    },
  );
  const summaryNotes = [t("consumptionTaxIncluded")];
  if (r.totals.taxPendingPayments > 0) {
    summaryNotes.push(t("consumptionTaxPending", { count: r.totals.taxPendingPayments }));
  }

  const sections: ThermalReportSection[] = [
    { title: t("summary"), rows: summaryRows, notes: summaryNotes },
  ];

  // ── Por método de pago ──────────────────────────────────────────────
  sections.push({
    title: t("byMethodTitle"),
    rows:
      r.byMethod.length === 0
        ? []
        : [
            ...r.byMethod.map((m) => ({
              label: `${args.methodLabel(m.method)} (${m.count})`,
              value: money(m.grossCents),
            })),
            { label: t("total"), value: money(r.totals.grossCents), strong: true },
          ],
    notes: r.byMethod.length === 0 ? [t("noPayments")] : [],
  });

  // ── Por mesero: lo cobrado, y debajo su efectivo y su propina ───────
  if (r.byWaiter.length > 0) {
    const rows: ThermalReportRow[] = [];
    for (const w of r.byWaiter) {
      rows.push({ label: `${w.userLabel} (${w.count})`, value: money(w.grossCents) });
      rows.push({ label: `· ${t("thCash")}`, value: money(w.cashCents) });
      rows.push({ label: `· ${t("thTip")}`, value: money(w.tipCents) });
      if (w.tipReturnedCents > 0) {
        rows.push({ label: "", value: tTips("waiterReturned", { amount: money(w.tipReturnedCents) }) });
      }
    }
    sections.push({ title: t("byWaiterTitle"), rows, notes: [] });
  }

  // ── Efectivo y arqueo ───────────────────────────────────────────────
  const diff = r.shift.cashDiffCents;
  sections.push({
    title: t("cashAndCount"),
    rows: [
      { label: t("baseInitial"), value: money(r.shift.openingCashCents) },
      { label: t("cashReceived"), value: money(r.cash.receivedCents) },
      { label: t("changeGiven"), value: money(r.cash.changeGivenCents) },
      {
        label: t("expectedInDrawer"),
        value: r.shift.expectedCashCents != null ? money(r.shift.expectedCashCents) : dash,
      },
      {
        label: t("declaredAtClose"),
        value: r.shift.declaredCashCents != null ? money(r.shift.declaredCashCents) : dash,
      },
      {
        label: t("difference"),
        value: diff != null ? `${diff > 0 ? "+" : diff < 0 ? "-" : ""}${money(Math.abs(diff))}` : dash,
        strong: true,
      },
    ],
    notes: r.shift.notes?.trim()
      ? [
          t("notes") + ":",
          ...r.shift.notes
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l.length > 0),
        ]
      : [],
  });

  return {
    paperWidthMm: args.paperWidthMm,
    businessName: args.merchant,
    businessLines: args.taxId ? [t("taxId", { taxId: args.taxId })] : [],
    title: t("shiftClose").toUpperCase(),
    metaRows,
    sections,
    footerLines: [args.generatedLabel],
  };
}

/** Clave de `opShifts` de cada método de pago (la misma de la pantalla). */
export const SHIFT_METHOD_KEY: Record<string, string> = {
  demo_card: "methodDemoCard",
  // Efectivo: el histórico (demo_cash) y el actual (cash) se rotulan igual.
  demo_cash: "methodCash",
  cash: "methodCash",
  wompi_card: "methodWompiCard",
  wompi_pse: "methodWompiPse",
  wompi_nequi: "methodWompiNequi",
  kushki_apple_pay: "methodKushkiApplePay",
  kushki_google_pay: "methodKushkiGooglePay",
  kushki_card_terminal: "methodKushkiCardTerminal",
  kushki_card: "methodKushkiCard",
  external_terminal: "methodExternalTerminal",
  kushki_pse: "methodKushkiPse",
  reservation_deposit: "methodReservationDeposit",
  voucher: "methodVoucher",
  customer_credit: "methodCustomerCredit",
};

/** "3h 20m" / "45m" / "—" (como la pantalla del turno). */
export function shiftDurationLabel(ms: number, t: ShiftCloseTranslator): string {
  if (ms <= 0) return t("emptyDash");
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return t("durationM", { m });
  return t("durationHm", { h, m });
}
