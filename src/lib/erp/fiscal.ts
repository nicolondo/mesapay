// Fase 4 — impuestos y cierre.
//  - loadTaxDeclaration: posición fiscal del mes (IVA/INC a pagar, retenciones)
//    derivada del resumen de impuestos existente.
//  - generateYearClosing: asiento de cierre anual que cancela las cuentas de
//    resultado (clases 4/5/6) contra 3605/3610 (utilidad/pérdida del ejercicio).
import { db } from "@/lib/db";
import { computeTaxSummary, type MonthRange } from "./accountingData";
import { ensureChartOfAccounts, loadAccountMap } from "./ledger";

export type TaxDeclaration = {
  salesKind: string;
  salesPct: number;
  salesBaseCents: number;
  ivaGeneradoCents: number;
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
  const kind = tax.sales.kind;
  const ivaGenerado = kind === "iva" ? tax.sales.taxCents : 0;
  const incGenerado = kind === "inc" ? tax.sales.taxCents : 0;
  const ivaDescontable = tax.purchases.ivaCents;
  return {
    salesKind: kind,
    salesPct: tax.sales.pct,
    salesBaseCents: tax.sales.baseCents,
    ivaGeneradoCents: ivaGenerado,
    incGeneradoCents: incGenerado,
    ivaDescontableCents: ivaDescontable,
    // Sólo el régimen IVA cruza generado vs descontable; en INC la compra de
    // IVA es costo, no crédito.
    ivaAPagarCents:
      kind === "iva" ? Math.max(0, ivaGenerado - ivaDescontable) : 0,
    incAPagarCents: incGenerado,
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
    where: { restaurantId, source: "closing", sourceRef: year },
    include: { lines: true },
  });
  if (!entry) {
    return { year, exists: false, dateISO: null, resultCents: 0, kind: "none" };
  }
  const util = entry.lines.find((l) => l.accountCode === "360505");
  const perd = entry.lines.find((l) => l.accountCode === "361005");
  const resultCents = util
    ? util.creditCents
    : perd
      ? -perd.debitCents
      : 0;
  return {
    year,
    exists: true,
    dateISO: entry.date.toISOString(),
    resultCents,
    kind: resultCents > 0 ? "utilidad" : resultCents < 0 ? "perdida" : "none",
  };
}

/**
 * Genera (o refresca) el asiento de cierre del año: cancela cada cuenta de
 * resultado posteando lo opuesto a su saldo, y lleva el neto a utilidad (3605,
 * crédito) o pérdida (3610, débito). Idempotente por (source=closing, año).
 */
export async function generateYearClosing(
  restaurantId: string,
  year: string,
): Promise<ClosingStatus> {
  await ensureChartOfAccounts(restaurantId);
  const map = await loadAccountMap(restaurantId);
  const y = Number(year);
  const from = new Date(Date.UTC(y, 0, 1));
  const to = new Date(Date.UTC(y + 1, 0, 1));

  const rows = await db.journalLine.groupBy({
    by: ["accountCode"],
    where: {
      entry: {
        restaurantId,
        date: { gte: from, lt: to },
        source: { not: "closing" },
      },
    },
    _sum: { debitCents: true, creditCents: true },
  });

  const lines: { code: string; debit?: number; credit?: number }[] = [];
  let net = 0; // Σ(crédito − débito) sobre 4/5/6 = ingresos − gastos − costos
  for (const r of rows) {
    const cls = r.accountCode[0];
    if (cls !== "4" && cls !== "5" && cls !== "6") continue;
    const d = r._sum.debitCents ?? 0;
    const c = r._sum.creditCents ?? 0;
    const netLine = c - d;
    if (netLine === 0) continue;
    // Cerrar = postear lo opuesto al saldo de la cuenta.
    if (netLine > 0) lines.push({ code: r.accountCode, debit: netLine });
    else lines.push({ code: r.accountCode, credit: -netLine });
    net += netLine;
  }

  if (lines.length === 0) {
    await db.journalEntry.deleteMany({
      where: { restaurantId, source: "closing", sourceRef: year },
    });
    return { year, exists: false, dateISO: null, resultCents: 0, kind: "none" };
  }

  if (net > 0) lines.push({ code: "360505", credit: net });
  else if (net < 0) lines.push({ code: "361005", debit: -net });

  if (lines.some((l) => !map.get(l.code))) {
    console.error("[closing] cuenta faltante", { year });
    return loadClosing(restaurantId, year);
  }

  const date = new Date(to.getTime() - 1); // 31 dic
  await db.$transaction(async (tx) => {
    await tx.journalEntry.deleteMany({
      where: { restaurantId, source: "closing", sourceRef: year },
    });
    await tx.journalEntry.create({
      data: {
        restaurantId,
        date,
        source: "closing",
        sourceRef: year,
        memo: `Cierre del ejercicio ${year}`,
        status: "posted",
        lines: {
          create: lines.map((l) => ({
            accountId: map.get(l.code)!,
            accountCode: l.code,
            debitCents: l.debit ?? 0,
            creditCents: l.credit ?? 0,
          })),
        },
      },
    });
  });

  return {
    year,
    exists: true,
    dateISO: date.toISOString(),
    resultCents: net,
    kind: net > 0 ? "utilidad" : net < 0 ? "perdida" : "none",
  };
}
