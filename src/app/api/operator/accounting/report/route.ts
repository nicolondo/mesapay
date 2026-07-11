import { NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { getErpContext, isDenied } from "@/lib/erp/access";
import {
  buildXlsxWorkbook,
  centsToAmount,
  monthRange,
  type XlsxSheet,
} from "@/lib/erp/accounting";
import {
  computeTaxSummary,
  loadCogsBook,
  loadInventoryBook,
  loadPurchasesBook,
  loadSalesBook,
} from "@/lib/erp/accountingData";
import { formatBaseQty } from "@/lib/erp/units";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

function isoDate(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : "";
}

/**
 * Reporte para el contador en un solo archivo Excel (.xls SpreadsheetML, sin
 * dependencias) con hojas: Ventas, Retenciones, Costos de ventas (CMV) e
 * Inventarios. Montos como número para que el contador los sume/filtre.
 */
export async function GET(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { searchParams } = new URL(req.url);
  const month = searchParams.get("month") ?? "";
  const range = monthRange(month);
  if (!range) return NextResponse.json({ error: "invalid" }, { status: 400 });

  const t = await getTranslations("opErp");
  const [sales, purchases, cogs, inventory, tax] = await Promise.all([
    loadSalesBook(ctx.restaurantId, range),
    loadPurchasesBook(ctx.restaurantId, range),
    loadCogsBook(ctx.restaurantId, range),
    loadInventoryBook(ctx.restaurantId),
    computeTaxSummary(ctx.restaurantId, range),
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
        [...new Set(o.payments.map((p) => p.method))].join(" | "),
        o.simpleInvoice ? String(o.simpleInvoice.invoiceNumber) : "",
      ]),
      [
        t("repTotal"),
        "",
        "",
        centsToAmount(sales.totals.subtotalCents),
        centsToAmount(sales.totals.tipCents),
        centsToAmount(sales.totals.taxCents),
        centsToAmount(sales.totals.totalCents),
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

  const xml = buildXlsxWorkbook([ventas, retenciones, costos, inventarios]);
  return new NextResponse(xml, {
    headers: {
      "Content-Type": "application/vnd.ms-excel; charset=utf-8",
      "Content-Disposition": `attachment; filename="mesapay-contador-${month}.xls"`,
    },
  });
}
