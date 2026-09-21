import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { chartToCsv, type PlanAccount } from "@/lib/erp/chart";
import { loadChartOfAccounts } from "@/lib/erp/ledger";
import type { ModuleSlug } from "@/lib/modules";
import type { PucNature, PucType } from "@/lib/erp/pucNiif";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

/**
 * Plan de cuentas completo (activas e inactivas) como CSV descargable, en
 * el mismo dialecto que acepta la importación: lo que sale de acá se puede
 * volver a pegar en "Importar plan de cuentas".
 */
async function GETHandler() {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const chart = await loadChartOfAccounts(ctx.restaurantId, {
    includeInactive: true,
  });
  const rows: PlanAccount[] = chart.map((a) => ({
    code: a.code,
    name: a.name,
    type: a.type as PucType,
    nature: a.nature as PucNature,
    postable: a.postable,
    active: a.active,
  }));
  return new Response(chartToCsv(rows), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="plan-de-cuentas.csv"',
      "cache-control": "no-store",
    },
  });
}

export const GET = secureApi(GETHandler);
