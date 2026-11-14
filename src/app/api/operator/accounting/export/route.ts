import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import {
  centsToCsvAmount,
  toCsv,
} from "@/lib/erp/accounting";
import {
  accountingMonthRange,
  loadPurchasesBook,
  loadSalesBook,
} from "@/lib/erp/accountingData";
import { reportingPaymentMethod } from "@/lib/payments/methods";
import { expenseBaseCents, expensePayableCents, isExpenseDocumentType } from "@/lib/erp/expenseTax";
import { bogotaTodayIso } from "@/lib/bogota";
import {
  expenseListWhere,
  hasExpenseFilters,
  matchesStatus,
  parseExpenseListParams,
  type ExpenseListFilters,
} from "@/lib/erp/expenseList";
import { ensureExpenseNumbers, formatExpenseNumber } from "@/lib/erp/expenseNumber";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

function isoDate(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : "";
}

/**
 * Export CSV del mes (spec B2 · D5): ventas | compras | gastos. En ventas,
 * las notas crédito aceptadas del mes van al final como documentos en
 * NEGATIVO (código = número de la nota, factura = la que ajusta). UTF-8
 * con BOM (Excel muestra bien los acentos), montos en unidades de moneda
 * con punto decimal, encabezados en el idioma del usuario. Columnas
 * genéricas mapeables a Siigo/Alegra/Contpaqi.
 */
async function GETHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { searchParams } = new URL(req.url);
  const book = searchParams.get("book");
  const month = searchParams.get("month") ?? "";
  // Gastos: además del mes, la lista FILTRADA tal como se ve en pantalla
  // (período libre, búsqueda, proveedor, concepto, cuenta, estado; mismos
  // parámetros que la lista, ver expenseList.ts).
  const expenseFilters: ExpenseListFilters | null =
    book === "expenses" ? parseExpenseListParams(searchParams) : null;
  // Mes de NEGOCIO del comercio para ventas y compras (como el libro); los
  // gastos viven en una FECHA y van por el mes calendario (`calendar`).
  const range = await accountingMonthRange(ctx.restaurantId, month);
  if (
    !["sales", "purchases", "expenses"].includes(book ?? "") ||
    (book === "expenses" ? !expenseFilters : !range)
  ) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const t = await getTranslations("opErp");
  let filename = `mesapay-${book}-${month}.csv`;

  let csv: string;
  if (book === "sales") {
    const { orders, creditNotes } = await loadSalesBook(ctx.restaurantId, range!);
    csv = toCsv(
      [
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
      [
        ...orders.map((o) => [
          isoDate(o.paidAt),
          o.shortCode,
          o.table ? (o.table.label ?? String(o.table.number)) : "",
          centsToCsvAmount(o.subtotalCents),
          centsToCsvAmount(o.tipCents),
          centsToCsvAmount(o.taxCents),
          centsToCsvAmount(o.totalCents),
          // El efectivo histórico (demo_cash) sale como "cash", como el de hoy.
          [...new Set(o.payments.map((p) => reportingPaymentMethod(p.method)))].join(" | "),
          o.simpleInvoice ? String(o.simpleInvoice.invoiceNumber) : "",
        ]),
        // Notas crédito: el subtotal (como el de las cuentas) lleva el
        // impuesto embebido, así que va el total de la nota en negativo.
        ...creditNotes.map((n) => [
          n.date,
          n.documentNumber,
          t("csvCreditNote"),
          centsToCsvAmount(-n.totalCents),
          centsToCsvAmount(0),
          centsToCsvAmount(0),
          centsToCsvAmount(-n.totalCents),
          "",
          n.invoiceNumber,
        ]),
      ],
    );
  } else if (book === "purchases") {
    const { rows } = await loadPurchasesBook(ctx.restaurantId, range!);
    csv = toCsv(
      [
        t("csvDate"),
        t("csvPoNumber"),
        t("csvSupplier"),
        t("csvSupplierInvoice"),
        t("csvNet"),
        t("csvIva"),
        t("csvInc"),
        t("csvRetefuente"),
        t("csvReteIva"),
        t("csvReteIca"),
        t("csvTotal"),
        t("csvDueDate"),
        t("csvPaidDate"),
      ],
      rows.map((r) => {
        // Total a pagar = neto + IVA + INC − retenciones.
        const total =
          r.receivedCents +
          r.ivaCents +
          r.incCents -
          r.retefuenteCents -
          r.reteIvaCents -
          r.reteIcaCents;
        return [
          isoDate(r.receivedAt),
          `OC-${String(r.number).padStart(4, "0")}`,
          r.supplierName,
          r.supplierInvoiceNumber ?? "",
          centsToCsvAmount(r.receivedCents),
          centsToCsvAmount(r.ivaCents),
          centsToCsvAmount(r.incCents),
          centsToCsvAmount(r.retefuenteCents),
          centsToCsvAmount(r.reteIvaCents),
          centsToCsvAmount(r.reteIcaCents),
          centsToCsvAmount(total),
          isoDate(r.invoiceDueAt),
          isoDate(r.paidAt),
        ];
      }),
    );
  } else {
    const filters = expenseFilters!;
    // El mes solo, sin filtros, es el libro de siempre (con las compras que
    // no van al inventario al final); con filtros, exactamente la lista.
    const wholeMonth = filters.period.kind === "month" && !hasExpenseFilters(filters);
    await ensureExpenseNumbers(ctx.restaurantId);
    const today = bogotaTodayIso();
    const expenses = (
      await db.expense.findMany({
        where: await expenseListWhere(ctx.restaurantId, filters),
        orderBy: [{ date: "asc" }, { number: "asc" }],
        include: { supplier: { select: { name: true, taxId: true } } },
      })
    ).filter((e) => matchesStatus(e, filters.status, today));
    const purchases = wholeMonth && range
      ? await loadPurchasesBook(ctx.restaurantId, range)
      : { rows: [] as Awaited<ReturnType<typeof loadPurchasesBook>>["rows"] };
    filename =
      filters.period.kind === "month"
        ? `mesapay-expenses-${filters.period.month}.csv`
        : filters.period.kind === "range"
          ? `mesapay-expenses-${filters.period.desde}_${filters.period.hasta}.csv`
          : "mesapay-expenses.csv";
    // «Monto» sigue siendo el COSTO del gasto (lo del PYG); a la derecha,
    // el documento y los impuestos, y el total a pagar al proveedor.
    const docLabel = (type: string, number: string | null) => {
      const kind = isExpenseDocumentType(type) && type !== "none" ? t(`expenseDocType_${type}`) : "";
      return [kind, number ?? ""].filter(Boolean).join(" ");
    };
    csv = toCsv(
      [
        t("csvExpenseNumber"),
        t("csvDate"),
        t("csvCategory"),
        t("csvDescription"),
        t("csvSupplier"),
        t("csvAmount"),
        t("csvSupplierTaxId"),
        t("csvDocument"),
        t("csvNet"),
        t("csvIva"),
        t("csvInc"),
        t("csvRetefuente"),
        t("csvReteIva"),
        t("csvReteIca"),
        t("csvPayable"),
      ],
      [...expenses.map((e) => [
        formatExpenseNumber(e.number) ?? "",
        isoDate(e.date),
        e.category,
        e.description ?? "",
        e.supplier?.name ?? "",
        centsToCsvAmount(e.amountCents),
        e.supplier?.taxId ?? "",
        docLabel(e.documentType, e.documentNumber),
        centsToCsvAmount(expenseBaseCents(e)),
        centsToCsvAmount(e.ivaCents),
        centsToCsvAmount(e.incCents),
        centsToCsvAmount(e.retefuenteCents),
        centsToCsvAmount(e.reteIvaCents),
        centsToCsvAmount(e.reteIcaCents),
        centsToCsvAmount(expensePayableCents(e)),
      ]), ...purchases.rows
        .filter((p) => p.nonInventoryReceivedCents + p.nonInventoryIncCents + p.nonInventoryNonDeductibleTaxCents > 0)
        .map((p) => ["", isoDate(p.receivedAt), t("nonInventoryPurchases"),
          `${p.supplierInvoiceNumber ?? p.number} · ${t("nonInventoryPurchasesTiming")}`, p.supplierName,
          centsToCsvAmount(p.nonInventoryReceivedCents + p.nonInventoryIncCents + p.nonInventoryNonDeductibleTaxCents),
          "", "", "", "", "", "", "", "", ""])],
    );
  }

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

export const GET = secureApi(GETHandler);
