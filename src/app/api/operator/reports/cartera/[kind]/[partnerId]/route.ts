import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { buildStatement, type CarteraKind } from "@/lib/erp/reports/cartera";
import { loadPartnerMovements } from "@/lib/erp/reports/carteraQueries";
import { carteraStatementQuery, searchParamsToObject } from "@/lib/erp/reports/params";
import { todayIso } from "@/lib/erp/reports/period";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

/** Segmento de la URL → lado de la cartera. */
const KIND_BY_SLUG: Record<string, CarteraKind> = { proveedor: "cxp", cliente: "cxc" };

/**
 * Extracto de un tercero: `/cartera/{proveedor|cliente}/{partnerId}?hasta`.
 * JSON `{ asOf, kind, partner, entries, aging, totals }` con saldo corrido
 * y tabla de edades (ver `buildStatement`). 404 si el tercero no es del
 * comercio (o si se pide un cliente con el módulo de bonos apagado).
 */
async function GETHandler(
  req: Request,
  { params }: { params: Promise<{ kind: string; partnerId: string }> },
) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { kind: slug, partnerId } = await params;
  const kind = KIND_BY_SLUG[slug];
  if (!kind) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const parsed = carteraStatementQuery.safeParse(
    searchParamsToObject(new URL(req.url).searchParams),
  );
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const asOf = parsed.data.hasta ?? todayIso();
  const data = await loadPartnerMovements(ctx.restaurantId, kind, partnerId, asOf);
  if (!data) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const statement = buildStatement(data.docs, data.payments, asOf);
  return NextResponse.json({ asOf, kind, partner: data.partner, ...statement });
}

export const GET = secureApi(GETHandler);
