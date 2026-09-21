import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { getErpContext, isDenied } from "@/lib/erp/access";
import {
  BUCKET_I18N_KEY,
  buildPartnerSummary,
  carteraCsvRows,
  NO_SUPPLIER_ID,
  type PartnerSummary,
} from "@/lib/erp/reports/cartera";
import { loadPayablesDocs, loadReceivableDocs } from "@/lib/erp/reports/carteraQueries";
import { buildReportCsv, csvResponse } from "@/lib/erp/reports/csv";
import { carteraQuery, searchParamsToObject } from "@/lib/erp/reports/params";
import { todayIso } from "@/lib/erp/reports/period";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

/**
 * Cartera por tercero a una fecha de corte: `?vista=todas|cxc|cxp&hasta
 * [&format=csv]`. JSON `{ asOf, receivables: { enabled, partners, totals },
 * payables: { partners, totals } }` — siempre los dos lados (`vista` es
 * cosa de la pantalla). En CSV sale UN archivo: el de clientes con
 * `vista=cxc` (`cartera-clientes-<hasta>.csv`) y el de proveedores en
 * cualquier otro caso (`cartera-proveedores-<hasta>.csv`), porque una
 * respuesta HTTP no puede llevar dos descargas.
 */
async function GETHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const parsed = carteraQuery.safeParse(searchParamsToObject(new URL(req.url).searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const q = parsed.data;
  const asOf = q.hasta ?? todayIso();

  const [payableDocs, receivable] = await Promise.all([
    loadPayablesDocs(ctx.restaurantId, asOf),
    loadReceivableDocs(ctx.restaurantId, asOf),
  ]);
  const payables = buildPartnerSummary(payableDocs, asOf);
  const receivables = buildPartnerSummary(receivable.docs, asOf);

  if (q.format === "csv") {
    const t = await getTranslations("opCartera");
    const cxc = q.vista === "cxc";
    const side = cxc ? receivables : payables;
    const partnerLabel = (p: PartnerSummary) =>
      p.partnerId === NO_SUPPLIER_ID ? t("noSupplier") : p.partnerName;
    const csv = buildReportCsv({
      headers: [
        t("colPartner"),
        t("colTaxId"),
        t("colDocs"),
        t("colOldestDue"),
        t("colAging"),
        t("colBalance"),
      ],
      rows: carteraCsvRows(side.partners, {
        partnerLabel,
        bucketLabel: (b) => t(BUCKET_I18N_KEY[b]),
      }),
      note: t("csvNote", { date: asOf }),
    });
    return csvResponse(`${cxc ? "cartera-clientes" : "cartera-proveedores"}-${asOf}.csv`, csv);
  }

  return NextResponse.json({
    asOf,
    receivables: { enabled: receivable.enabled, ...receivables },
    payables,
  });
}

export const GET = secureApi(GETHandler);
