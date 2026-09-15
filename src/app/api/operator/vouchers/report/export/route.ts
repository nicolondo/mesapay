import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { centsToCsvAmount, toCsv } from "@/lib/erp/accounting";
import type { ModuleSlug } from "@/lib/modules";
import { dayRange, loadVoucherReport } from "@/lib/vouchers/statement";

export const dynamic = "force-dynamic";

/**
 * Export CSV del reporte de bonos usados (mismo formato que los libros
 * contables: UTF-8 con BOM, montos con punto decimal, encabezados en el
 * idioma del usuario). Filtros: ?customer=&from=YYYY-MM-DD&to=YYYY-MM-DD
 */
const GATE: ModuleSlug[] = ["vouchers"];

async function GETHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { searchParams } = new URL(req.url);
  const range = dayRange(searchParams.get("from"), searchParams.get("to"));
  if (!range) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const customer = searchParams.get("customer")?.trim() || null;
  const t = await getTranslations("opVouchers");
  const rows = await loadVoucherReport({
    restaurantId: ctx.restaurantId,
    billingCustomerId: customer,
    from: range.from,
    to: range.to,
  });
  const csv = toCsv(
    [
      t("csvDate"),
      t("csvCustomer"),
      t("csvCode"),
      t("csvOrder"),
      t("csvAmount"),
      t("csvVoucherBalance"),
      t("csvMode"),
      t("csvChannel"),
      t("csvStatement"),
    ],
    rows.map((r) => [
      r.redeemedAt.toISOString().slice(0, 10),
      r.customerName,
      r.code,
      r.orderCode,
      centsToCsvAmount(r.amountCents),
      centsToCsvAmount(r.voucherBalanceCents),
      r.mode,
      r.channel,
      r.statementId ?? "",
    ]),
  );
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="bonos-${searchParams.get("from")}-${searchParams.get("to")}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}

export const GET = secureApi(GETHandler);
