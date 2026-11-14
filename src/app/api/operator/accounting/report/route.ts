import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { getErpContext, isDenied } from "@/lib/erp/access";
import {
  buildXlsxWorkbook,
  centsToAmount,
  type XlsxSheet,
} from "@/lib/erp/accounting";
import {
  accountingMonthRange,
  calendarRangeOf,
  computeTaxSummary,
  loadCogsBook,
  loadInventoryBook,
  loadPurchasesBook,
  loadSalesBook,
} from "@/lib/erp/accountingData";
import { formatBaseQty } from "@/lib/erp/units";
import { db } from "@/lib/db";
import { expenseBaseCents, expensePayableCents } from "@/lib/erp/expenseTax";
import { ensureExpenseNumbers, formatExpenseNumber } from "@/lib/erp/expenseNumber";
import { reportingPaymentMethod } from "@/lib/payments/methods";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

function isoDate(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : "";
}

/**
 * Reporte para el contador en un solo archivo Excel (.xls SpreadsheetML, sin
 * dependencias) con hojas: Ventas, Retenciones, Gastos (con su consecutivo
 * G-0001), Costos de ventas (CMV) e Inventarios. Montos como número para que el contador los sume/filtre.
 * En Ventas, las notas crédito aceptadas del mes van como documentos en
 * negativo y el total es NETO de ellas; una fila aparte muestra la base y
 * el impuesto que restaron.
 */
async function GETHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { searchParams } = new URL(req.url);
  const month = searchParams.get("month") ?? "";
  // Mes de NEGOCIO del comercio: ventas, compras, CMV e impuestos cortan
  // como los asientos del libro (las notas crédito, por su día fiscal).
  const range = await accountingMonthRange(ctx.restaurantId, month);
  if (!range) return NextResponse.json({ error: "invalid" }, { status: 400 });

  const t = await getTranslations("opErp");
  await ensureExpenseNumbers(ctx.restaurantId);
  // Gastos: FECHA contable, mes calendario (como su CSV y el motor).
  const calendar = calendarRangeOf(range);
  const [sales, purchases, cogs, inventory, tax, expenses] = await Promise.all([
    loadSalesBook(ctx.restaurantId, range),
    loadPurchasesBook(ctx.restaurantId, range),
    loadCogsBook(ctx.restaurantId, range),
    loadInventoryBook(ctx.restaurantId),
    computeTaxSummary(ctx.restaurantId, range),
    db.expense.findMany({
      where: { restaurantId: ctx.restaurantId, recurring: false, date: { gte: calendar.from, lt: calendar.to } },
      orderBy: [{ date: "asc" }, { number: "asc" }],
      include: { supplier: { select: { name: true, taxId: true } } },
    }),
  ]);

  // ── Ventas ──────────────────────────────────────────────────────────────
  const ventas: XlsxSheet = {
    name: t("repSheetSales"),
    headers: [
      t("csvDate"),
      t("csvOrderCode"),
      t("csvTable"),
      t("csvSubtotal"),
      t("csvTip"),
      t("csvTax"),
      t("csvTotal"),
      t("csvPaymentMethods"),
      t("csvInvoiceNumber"),
    ],
    rows: [
      ...sales.orders.map((o) => [
        isoDate(o.paidAt),
        o.shortCode,
        o.table ? (o.table.label ?? String(o.table.number)) : "",
        centsToAmount(o.subtotalCents),
        centsToAmount(o.tipCents),
        centsToAmount(o.taxCents),
        centsToAmount(o.totalCents),
        // El efectivo histórico (demo_cash) sale como "cash", como el de hoy.
        [...new Set(o.payments.map((p) => reportingPaymentMethod(p.method)))].join(" | "),
        o.simpleInvoice ? String(o.simpleInvoice.invoiceNumber) : "",
      ]),
      // Notas crédito: el subtotal de las cuentas lleva el impuesto
      // embebido, así que la nota va por su total en negativo.
      ...sales.creditNotes.map((n) => [
        n.date,
        n.documentNumber,
        t("csvCreditNote"),
        centsToAmount(-n.totalCents),
        centsToAmount(0),
        centsToAmount(0),
        centsToAmount(-n.totalCents),
        "",
        n.invoiceNumber,
      ]),
      [
        t("repTotal"),
        "",
        "",
        centsToAmount(sales.totals.subtotalCents - sales.creditNoteTotals.totalCents),
        centsToAmount(sales.totals.tipCents),
        centsToAmount(sales.totals.taxCents),
        centsToAmount(sales.totals.totalCents - sales.creditNoteTotals.totalCents),
        "",
        "",
      ],
      // Impuesto de ventas causado (INC/IVA embebido), según config.
      [
        tax.sales.kind === "none" ? t("repSalesTaxNone") : t("repSalesTaxCaused"),
        "",
        "",
        centsToAmount(tax.sales.baseCents),
        "",
        centsToAmount(tax.sales.taxCents),
        "",
        "",
        "",
      ],
      // Lo que restaron las notas crédito del mes (base e impuesto exactos
      // de cada nota, por eso va aparte del impuesto causado).
      ...(sales.creditNoteTotals.count > 0
        ? [
            [
              t("repCreditNoteTax"),
              "",
              "",
              centsToAmount(-sales.creditNoteTotals.subtotalCents),
              "",
              centsToAmount(-sales.creditNoteTotals.taxCents),
              "",
              "",
              "",
            ],
          ]
        : []),
    ],
  };

  // ── Retenciones (de compras) ──────────────────────────────────────────────
  const retRows = purchases.rows.filter(
    (r) => r.retefuenteCents || r.reteIvaCents || r.reteIcaCents,
  );
  const retenciones: XlsxSheet = {
    name: t("repSheetRetentions"),
    headers: [
      t("csvDate"),
      t("csvPoNumber"),
      t("csvSupplier"),
      t("csvSupplierInvoice"),
      t("csvRetefuente"),
      t("csvReteIva"),
      t("csvReteIca"),
    ],
    rows: [
      ...retRows.map((r) => [
        isoDate(r.receivedAt),
        `OC-${String(r.number).padStart(4, "0")}`,
        r.supplierName,
        r.supplierInvoiceNumber ?? "",
        centsToAmount(r.retefuenteCents),
        centsToAmount(r.reteIvaCents),
        centsToAmount(r.reteIcaCents),
      ]),
      [
        t("repTotal"),
        "",
        "",
        "",
        centsToAmount(purchases.totals.retefuenteCents),
        centsToAmount(purchases.totals.reteIvaCents),
        centsToAmount(purchases.totals.reteIcaCents),
      ],
    ],
  };

  // ── Gastos (con su consecutivo) ──────────────────────────────────────────
  const expenseRows = expenses.map((e) => {
    const payable = expensePayableCents(e);
    const retentions = e.retefuenteCents + e.reteIvaCents + e.reteIcaCents;
    return {
      cells: [
        formatExpenseNumber(e.number) ?? "",
        isoDate(e.date),
        e.category,
        e.supplier?.name ?? "",
        e.supplier?.taxId ?? "",
        e.documentNumber ?? "",
        centsToAmount(expenseBaseCents(e)),
        centsToAmount(e.ivaCents),
        centsToAmount(e.incCents),
        centsToAmount(retentions),
        centsToAmount(payable),
        centsToAmount(e.amountCents),
        centsToAmount(Math.max(0, payable - e.paidCents)),
      ],
      base: expenseBaseCents(e),
      iva: e.ivaCents,
      inc: e.incCents,
      retentions,
      payable,
      cost: e.amountCents,
      outstanding: Math.max(0, payable - e.paidCents),
    };
  });
  const sumOf = (k: "base" | "iva" | "inc" | "retentions" | "payable" | "cost" | "outstanding") =>
    centsToAmount(expenseRows.reduce((acc, r) => acc + r[k], 0));
  const gastos: XlsxSheet = {
    name: t("repSheetExpenses"),
    headers: [
      t("csvExpenseNumber"),
      t("csvDate"),
      t("csvCategory"),
      t("csvSupplier"),
      t("csvSupplierTaxId"),
      t("csvDocument"),
      t("csvNet"),
      t("csvIva"),
      t("csvInc"),
      t("repColRetentions"),
      t("csvPayable"),
      t("csvAmount"),
      t("repColOutstanding"),
    ],
    rows: [
      ...expenseRows.map((r) => r.cells),
      [
        t("repTotal"),
        "",
        "",
        "",
        "",
        "",
        sumOf("base"),
        sumOf("iva"),
        sumOf("inc"),
        sumOf("retentions"),
        sumOf("payable"),
        sumOf("cost"),
        sumOf("outstanding"),
      ],
    ],
  };

  // ── Costos de ventas (CMV) ────────────────────────────────────────────────
  const costos: XlsxSheet = {
    name: t("repSheetCogs"),
    headers: [t("repColIngredient"), t("csvCategory"), t("repColConsumed")],
    rows: [
      ...cogs.rows.map((r) => [
        r.ingredientName,
        r.category,
        centsToAmount(r.valueCents),
      ]),
      [t("repTotal"), "", centsToAmount(cogs.totals.valueCents)],
    ],
  };

  // ── Inventarios (snapshot actual) ─────────────────────────────────────────
  const inventarios: XlsxSheet = {
    name: t("repSheetInventory"),
    headers: [
      t("repColIngredient"),
      t("csvCategory"),
      t("repColOnHand"),
      t("repColValue"),
    ],
    rows: [
      ...inventory.rows.map((r) => [
        r.ingredientName,
        r.category,
        formatBaseQty(r.qtyBase, r.measureKind),
        centsToAmount(r.valueCents),
      ]),
      [t("repTotal"), "", "", centsToAmount(inventory.totals.valueCents)],
    ],
  };

  const xml = buildXlsxWorkbook([ventas, retenciones, gastos, costos, inventarios]);
  return new NextResponse(xml, {
    headers: {
      "Content-Type": "application/vnd.ms-excel; charset=utf-8",
      "Content-Disposition": `attachment; filename="mesapay-contador-${month}.xls"`,
    },
  });
}

export const GET = secureApi(GETHandler);
