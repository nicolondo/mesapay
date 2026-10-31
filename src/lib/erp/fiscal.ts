// Fase 4 — impuestos y cierre.
//  - loadTaxDeclaration: posición fiscal del mes (IVA/INC a pagar, retenciones)
//    derivada del resumen de impuestos existente.
//  - generateYearClosing: asiento de cierre anual que cancela las cuentas de
//    resultado (clases 4/5/6) contra 3605/3610 (utilidad/pérdida del ejercicio).
//    Un cierre ya numerado nunca se borra (ver la función).
import { db } from "@/lib/db";
import type { NetSalesTaxSlice, TaxSummary } from "./accounting";
import { computeTaxSummary, type MonthRange } from "./accountingData";
import { getAccountingConfig, isMonthClosed } from "./cierre";
import { ensureChartOfAccounts, loadAccountMap } from "./ledger";
import { centsToNumber } from "./ledgerCents";

export type TaxDeclaration = {
  salesKind: string;
  salesPct: number;
  /** Base gravable NETA de notas crédito y devoluciones. */
  salesBaseCents: number;
  /** IVA generado BRUTO: lo que facturó el mes. */
  ivaGeneradoBrutoCents: number;
  /** IVA que restaron las notas crédito aceptadas con fecha fiscal en el mes. */
  ivaNotasCreditoCents: number;
  /** IVA estimado de los reembolsos del mes sin nota crédito. */
  ivaDevolucionesCents: number;
  /** IVA generado NETO = bruto − notas − devoluciones. */
  ivaGeneradoCents: number;
  incGeneradoBrutoCents: number;
  incNotasCreditoCents: number;
  incDevolucionesCents: number;
  /** INC generado NETO = bruto − notas − devoluciones. */
  incGeneradoCents: number;
  ivaDescontableCents: number;
  ivaAPagarCents: number;
  incAPagarCents: number;
  purchaseIncCents: number;
  retefuenteCents: number;
  reteIvaCents: number;
  reteIcaCents: number;
};

export async function loadTaxDeclaration(
  restaurantId: string,
  range: MonthRange,
): Promise<TaxDeclaration> {
  const tax = await computeTaxSummary(restaurantId, range);
  return taxDeclarationFrom(tax);
}

/**
 * Posición fiscal del mes desde el resumen de impuestos (pura). Por tramo
 * (lo que cada factura congeló): un mes que mezcló tarifas suma su IVA y su
 * INC por separado en vez de mandar todo al régimen con el que quedó
 * etiquetado. El generado es NETO: las notas crédito aceptadas del mes
 * restan en la tarifa de sus líneas y los reembolsos sin nota, en el tramo
 * del mes — la misma regla de «Impuestos del período».
 */
export function taxDeclarationFrom(tax: TaxSummary): TaxDeclaration {
  const kind = tax.sales.kind;
  const sumKind = (k: "iva" | "inc", pick: (s: NetSalesTaxSlice) => number) =>
    tax.sales.net.byRate.filter((s) => s.kind === k).reduce((a, s) => a + pick(s), 0);
  const ivaBruto = sumKind("iva", (s) => s.grossTaxCents);
  const ivaNotas = sumKind("iva", (s) => s.creditNoteTaxCents);
  const ivaDevoluciones = sumKind("iva", (s) => s.refundTaxCents);
  const ivaGenerado = ivaBruto - ivaNotas - ivaDevoluciones;
  const incBruto = sumKind("inc", (s) => s.grossTaxCents);
  const incNotas = sumKind("inc", (s) => s.creditNoteTaxCents);
  const incDevoluciones = sumKind("inc", (s) => s.refundTaxCents);
  const incGenerado = incBruto - incNotas - incDevoluciones;
  const ivaDescontable = tax.purchases.ivaCents;
  return {
    salesKind: kind,
    salesPct: tax.sales.pct,
    salesBaseCents: tax.sales.net.baseCents,
    ivaGeneradoBrutoCents: ivaBruto,
    ivaNotasCreditoCents: ivaNotas,
    ivaDevolucionesCents: ivaDevoluciones,
    ivaGeneradoCents: ivaGenerado,
    incGeneradoBrutoCents: incBruto,
    incNotasCreditoCents: incNotas,
    incDevolucionesCents: incDevoluciones,
    incGeneradoCents: incGenerado,
    ivaDescontableCents: ivaDescontable,
    // Sólo el régimen IVA cruza generado vs descontable; en INC la compra de
    // IVA es costo, no crédito. Un neto negativo (devolviste más de lo que
    // vendiste) no se paga: es saldo a favor que revisa el contador.
    ivaAPagarCents:
      kind === "iva" ? Math.max(0, ivaGenerado - ivaDescontable) : 0,
    incAPagarCents: Math.max(0, incGenerado),
    purchaseIncCents: tax.purchases.incCents,
    retefuenteCents: tax.purchases.retefuenteCents,
    reteIvaCents: tax.purchases.reteIvaCents,
    reteIcaCents: tax.purchases.reteIcaCents,
  };
}

export type ClosingStatus = {
  year: string;
  exists: boolean;
  dateISO: string | null;
  resultCents: number;
  kind: "utilidad" | "perdida" | "none";
};

/** Estado del cierre de un año (si ya se generó y con qué resultado). */
export async function loadClosing(
  restaurantId: string,
  year: string,
): Promise<ClosingStatus> {
  const entry = await db.journalEntry.findFirst({
    // Un cierre ANULADO (numerado y sin líneas: el año quedó sin resultado)
    // conserva su número pero no cuenta como cierre vigente.
    where: { restaurantId, source: "closing", sourceRef: year, status: { not: "annulled" } },
    include: { lines: true },
  });
  if (!entry) {
    return { year, exists: false, dateISO: null, resultCents: 0, kind: "none" };
  }
  const util = entry.lines.find((l) => l.accountCode === "360505");
  const perd = entry.lines.find((l) => l.accountCode === "361005");
  // Los montos del libro son BIGINT (el cliente los devuelve como bigint);
  // acá siempre se trabaja en number (ver ledgerCents).
  const resultCents = util
    ? centsToNumber(util.creditCents)
    : perd
      ? -centsToNumber(perd.debitCents)
      : 0;
  return {
    year,
    exists: true,
    dateISO: entry.date.toISOString(),
    resultCents,
    kind: resultCents > 0 ? "utilidad" : resultCents < 0 ? "perdida" : "none",
  };
}

export type ClosingLine = { code: string; debit?: number; credit?: number };

/**
 * Líneas del asiento de cierre desde los saldos del año (pura): cancela
 * cada cuenta de resultado (clases 4, 5 y 6) posteando lo opuesto a su
 * saldo y lleva el neto a 360505 (utilidad, crédito) o 361005 (pérdida,
 * débito). Sin saldos de resultado no hay líneas.
 */
export function closingLinesFrom(
  rows: readonly { accountCode: string; debitCents: number; creditCents: number }[],
): { lines: ClosingLine[]; netCents: number } {
  const lines: ClosingLine[] = [];
  let net = 0; // Σ(crédito − débito) sobre 4/5/6 = ingresos − gastos − costos
  for (const r of [...rows].sort((a, b) => a.accountCode.localeCompare(b.accountCode))) {
    const cls = r.accountCode[0];
    if (cls !== "4" && cls !== "5" && cls !== "6") continue;
    const netLine = r.creditCents - r.debitCents;
    if (netLine === 0) continue;
    if (netLine > 0) lines.push({ code: r.accountCode, debit: netLine });
    else lines.push({ code: r.accountCode, credit: -netLine });
    net += netLine;
  }
  if (lines.length === 0) return { lines, netCents: 0 };
  if (net > 0) lines.push({ code: "360505", credit: net });
  else if (net < 0) lines.push({ code: "361005", debit: -net });
  return { lines, netCents: net };
}

/** ¿Las líneas guardadas son exactamente las que saldrían hoy? (orden indiferente) */
export function sameClosingLines(
  stored: readonly { accountCode: string; debitCents: number; creditCents: number }[],
  fresh: readonly ClosingLine[],
): boolean {
  const key = (code: string, d: number, c: number) => `${code}:${d}:${c}`;
  const a = stored.map((l) => key(l.accountCode, l.debitCents, l.creditCents)).sort();
  const b = fresh.map((l) => key(l.code, l.debit ?? 0, l.credit ?? 0)).sort();
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

export type YearClosingResult =
  | { ok: true; closing: ClosingStatus }
  /**
   * El cierre ya es un comprobante NUMERADO, diciembre está cerrado y los
   * saldos de hoy darían otro asiento: un comprobante numerado en un
   * período cerrado no se cambia ni se borra. Para corregirlo se reabre
   * hasta diciembre, se regenera (conserva el número) y se vuelve a cerrar.
   */
  | { ok: false; error: "closing_locked"; voucherNumber: number };

/**
 * Genera (o refresca) el asiento de cierre del año. Idempotente por
 * (source=closing, año).
 *
 * Un comprobante NUMERADO nunca se borra (antes se borraba y se creaba
 * otro sin número, dejando un hueco en el consecutivo):
 *  · sin número: se reemplaza como siempre (borrar y crear);
 *  · numerado y los saldos dan lo mismo: no se toca;
 *  · numerado con diciembre ABIERTO (se reabrió para corregir): se
 *    reescribe EN SU LUGAR, mismo id y mismo número; si el año quedó sin
 *    resultado, queda ANULADO (sin líneas) para no perder el número;
 *  · numerado con diciembre CERRADO y saldos distintos: se bloquea
 *    (`closing_locked`).
 */
export async function generateYearClosing(
  restaurantId: string,
  year: string,
): Promise<YearClosingResult> {
  await ensureChartOfAccounts(restaurantId);
  const y = Number(year);
  const from = new Date(Date.UTC(y, 0, 1));
  const to = new Date(Date.UTC(y + 1, 0, 1));

  const [map, cfg, existing, rows] = await Promise.all([
    loadAccountMap(restaurantId),
    getAccountingConfig(restaurantId),
    db.journalEntry.findFirst({
      where: { restaurantId, source: "closing", sourceRef: year },
      select: {
        id: true,
        voucherNumber: true,
        status: true,
        lines: { select: { accountCode: true, debitCents: true, creditCents: true } },
      },
    }),
    db.journalLine.groupBy({
      by: ["accountCode"],
      where: {
        entry: {
          restaurantId,
          date: { gte: from, lt: to },
          source: { not: "closing" },
        },
      },
      _sum: { debitCents: true, creditCents: true },
    }),
  ]);

  const { lines, netCents: net } = closingLinesFrom(
    rows.map((r) => ({
      accountCode: r.accountCode,
      debitCents: centsToNumber(r._sum.debitCents ?? 0),
      creditCents: centsToNumber(r._sum.creditCents ?? 0),
    })),
  );

  if (lines.some((l) => !map.get(l.code))) {
    console.error("[closing] cuenta faltante", { year });
    return { ok: true, closing: await loadClosing(restaurantId, year) };
  }

  const date = new Date(to.getTime() - 1); // 31 dic
  const memo = `Cierre del ejercicio ${year}`;
  const lineData = lines.map((l) => ({
    accountId: map.get(l.code)!,
    accountCode: l.code,
    debitCents: l.debit ?? 0,
    creditCents: l.credit ?? 0,
  }));

  // ── Ya es un comprobante numerado: nunca se borra ──────────────────────
  if (existing && existing.voucherNumber != null) {
    const annulled = existing.status === "annulled";
    const stored = existing.lines.map((l) => ({
      accountCode: l.accountCode,
      debitCents: centsToNumber(l.debitCents),
      creditCents: centsToNumber(l.creditCents),
    }));
    const unchanged = lines.length === 0 ? annulled : !annulled && sameClosingLines(stored, lines);
    if (unchanged) return { ok: true, closing: await loadClosing(restaurantId, year) };
    if (isMonthClosed(cfg.closedThrough, `${year}-12`)) {
      return { ok: false, error: "closing_locked", voucherNumber: existing.voucherNumber };
    }
    await db.$transaction(async (tx) => {
      await tx.journalLine.deleteMany({ where: { entryId: existing.id } });
      await tx.journalEntry.update({
        where: { id: existing.id },
        data:
          lines.length === 0
            ? { status: "annulled", annulledAt: new Date() }
            : {
                date,
                memo,
                status: "posted",
                annulledAt: null,
                lines: { create: lineData },
              },
      });
    });
    return { ok: true, closing: await loadClosing(restaurantId, year) };
  }

  // ── Sin número: se reemplaza ──────────────────────────────────────────
  if (lines.length === 0) {
    await db.journalEntry.deleteMany({
      where: { restaurantId, source: "closing", sourceRef: year, voucherNumber: null },
    });
    return { ok: true, closing: { year, exists: false, dateISO: null, resultCents: 0, kind: "none" } };
  }

  await db.$transaction(async (tx) => {
    // Guardia: sólo se borra el que sigue sin número (si el mes se cerró
    // entre la lectura y acá, el numerado se queda y el create choca con
    // la llave única: mejor un error que un comprobante borrado).
    await tx.journalEntry.deleteMany({
      where: { restaurantId, source: "closing", sourceRef: year, voucherNumber: null },
    });
    await tx.journalEntry.create({
      data: {
        restaurantId,
        date,
        source: "closing",
        sourceRef: year,
        memo,
        status: "posted",
        lines: { create: lineData },
      },
    });
  });

  return {
    ok: true,
    closing: {
      year,
      exists: true,
      dateISO: date.toISOString(),
      resultCents: net,
      kind: net > 0 ? "utilidad" : net < 0 ? "perdida" : "none",
    },
  };
}
