import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getActiveGroupShellContext } from "@/lib/activeRestaurant";
import { monthRange } from "@/lib/erp/accounting";
import { computeMonthPnl } from "@/lib/erp/accountingData";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { isModuleEnabled } from "@/lib/modules";

export const dynamic = "force-dynamic";

/**
 * P&L consolidado del grupo (spec B2 · D4): suma solo las sedes con el
 * módulo accounting activo; las apagadas se listan sin números. Grupos
 * multi-país agrupan por moneda — sin conversión (honesto y simple).
 */
export async function GET(req: Request) {
  const shell = await getActiveGroupShellContext();
  if (!shell) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { searchParams } = new URL(req.url);
  const month = searchParams.get("month") ?? "";
  const range = monthRange(month);
  if (!range) return NextResponse.json({ error: "invalid" }, { status: 400 });

  const restaurants = await db.restaurant.findMany({
    where: { groupId: shell.groupId },
    orderBy: { name: "asc" },
    select: { id: true, name: true, country: true, enabledModules: true },
  });

  const sites: Array<{
    restaurantId: string;
    name: string;
    currency: string;
    enabled: boolean;
    pnl: Awaited<ReturnType<typeof computeMonthPnl>> | null;
  }> = [];
  for (const r of restaurants) {
    const enabled = isModuleEnabled(r.enabledModules, "accounting");
    sites.push({
      restaurantId: r.id,
      name: r.name,
      currency: await getCurrencyForCountry(r.country),
      enabled,
      pnl: enabled ? await computeMonthPnl(r.id, range) : null,
    });
  }

  // Consolidado por moneda (solo sedes activas).
  const byCurrency = new Map<
    string,
    {
      currency: string;
      salesCents: number;
      consumptionCents: number;
      wasteCents: number;
      laborCents: number;
      expensesCents: number;
      grossProfitCents: number;
      operatingProfitCents: number;
      sites: number;
    }
  >();
  for (const s of sites) {
    if (!s.pnl) continue;
    let acc = byCurrency.get(s.currency);
    if (!acc) {
      acc = {
        currency: s.currency,
        salesCents: 0,
        consumptionCents: 0,
        wasteCents: 0,
        laborCents: 0,
        expensesCents: 0,
        grossProfitCents: 0,
        operatingProfitCents: 0,
        sites: 0,
      };
      byCurrency.set(s.currency, acc);
    }
    acc.salesCents += s.pnl.salesCents;
    acc.consumptionCents += s.pnl.consumptionCents;
    acc.wasteCents += s.pnl.wasteCents;
    acc.laborCents += s.pnl.labor?.totalCents ?? 0;
    acc.expensesCents += s.pnl.expensesCents;
    acc.grossProfitCents += s.pnl.grossProfitCents;
    acc.operatingProfitCents += s.pnl.operatingProfitCents;
    acc.sites++;
  }

  return NextResponse.json({
    month,
    sites,
    consolidated: [...byCurrency.values()],
  });
}
