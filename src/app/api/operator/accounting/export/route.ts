import { NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import {
  centsToCsvAmount,
  monthRange,
  toCsv,
} from "@/lib/erp/accounting";
import { loadPurchasesBook, loadSalesBook } from "@/lib/erp/accountingData";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

function isoDate(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : "";
}

/**
 * Export CSV del mes (spec B2 · D5): ventas | compras | gastos. UTF-8
 * con BOM (Excel muestra bien los acentos), montos en unidades de moneda
 * con punto decimal, encabezados en el idioma del usuario. Columnas
 * genéricas mapeables a Siigo/Alegra/Contpaqi.
 */
export async function GET(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { searchParams } = new URL(req.url);
  const book = searchParams.get("book");
  const month = searchParams.get("month") ?? "";
  const range = monthRange(month);
  if (!range || !["sales", "purchases", "expenses"].includes(book ?? "")) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const t = await getTranslations("opErp");

  let csv: string;
  if (book === "sales") {
    const { orders } = await loadSalesBook(ctx.restaurantId, range);
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
      orders.map((o) => [
        isoDate(o.paidAt),
        o.shortCode,
        o.table ? (o.table.label ?? String(o.table.number)) : "",
        centsToCsvAmount(o.subtotalCents),
        centsToCsvAmount(o.tipCents),
        centsToCsvAmount(o.taxCents),
        centsToCsvAmount(o.totalCents),
        [...new Set(o.payments.map((p) => p.method))].join(" | "),
        o.simpleInvoice ? String(o.simpleInvoice.invoiceNumber) : "",
      ]),
    );
  } else if (book === "purchases") {
    const { rows } = await loadPurchasesBook(ctx.restaurantId, range);
    csv = toCsv(
      [
        t("csvDate"),
        t("csvPoNumber"),
        t("csvSupplier"),
        t("csvSupplierInvoice"),
        t("csvTotal"),
        t("csvDueDate"),
        t("csvPaidDate"),
      ],
      rows.map((r) => [
        isoDate(r.receivedAt),
        `OC-${String(r.number).padStart(4, "0")}`,
        r.supplierName,
        r.supplierInvoiceNumber ?? "",
        centsToCsvAmount(r.receivedCents),
        isoDate(r.invoiceDueAt),
        isoDate(r.paidAt),
      ]),
    );
  } else {
    const expenses = await db.expense.findMany({
      where: {
        restaurantId: ctx.restaurantId,
        recurring: false,
        date: { gte: range.from, lt: range.to },
      },
      orderBy: { date: "asc" },
      include: { supplier: { select: { name: true } } },
    });
    csv = toCsv(
      [
        t("csvDate"),
        t("csvCategory"),
        t("csvDescription"),
        t("csvSupplier"),
        t("csvAmount"),
      ],
      expenses.map((e) => [
        isoDate(e.date),
        e.category,
        e.description ?? "",
        e.supplier?.name ?? "",
        centsToCsvAmount(e.amountCents),
      ]),
    );
  }

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="mesapay-${book}-${month}.csv"`,
    },
  });
}
