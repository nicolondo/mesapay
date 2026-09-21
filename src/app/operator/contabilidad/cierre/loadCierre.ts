import { notFound } from "next/navigation";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { isModuleEnabled } from "@/lib/modules";
import { getAccountingConfig } from "@/lib/erp/cierre";
import { loadClosing, type ClosingStatus } from "@/lib/erp/fiscal";
import {
  buildYearStatus,
  parseYearParam,
  type MonthCount,
  type YearStatus,
} from "@/lib/erp/cierrePeriodo";
import { todayIso } from "@/lib/erp/reports/period";

export type CierrePageData = {
  currency: string;
  /** Año en curso (zona del comercio), para acotar el selector de año. */
  currentYear: number;
  config: { closedThrough: string | null; nextVoucherNumber: number };
  status: YearStatus;
  closing: ClosingStatus;
};

/**
 * Comprobantes por mes del año (y cuántos ya tienen número): un GROUP BY
 * sobre la fecha, en vez de doce lecturas del diario. Los meses se cortan en
 * UTC, igual que `closeMonth` numera (fecha < 1.º del mes siguiente UTC).
 */
async function countEntriesByMonth(
  restaurantId: string,
  year: number,
): Promise<MonthCount[]> {
  const from = new Date(Date.UTC(year, 0, 1));
  const to = new Date(Date.UTC(year + 1, 0, 1));
  const rows = await db.$queryRaw<{ month: string; entries: number; numbered: number }[]>(
    Prisma.sql`
      SELECT to_char(e."date", 'YYYY-MM') AS "month",
             COUNT(*)::int AS "entries",
             COUNT(e."voucherNumber")::int AS "numbered"
      FROM "JournalEntry" e
      WHERE e."restaurantId" = ${restaurantId}
        AND e."date" >= ${from}
        AND e."date" < ${to}
      GROUP BY 1
      ORDER BY 1
    `,
  );
  return rows.map((r) => ({
    month: r.month,
    entries: Number(r.entries),
    numbered: Number(r.numbered),
  }));
}

/** Mes (YYYY-MM) del comprobante más antiguo del comercio, o null si no hay. */
async function firstEntryMonth(restaurantId: string): Promise<string | null> {
  const first = await db.journalEntry.findFirst({
    where: { restaurantId },
    orderBy: { date: "asc" },
    select: { date: true },
  });
  return first ? first.date.toISOString().slice(0, 7) : null;
}

/**
 * Gate + datos de /operator/contabilidad/cierre. Mismo criterio que
 * `contabilidad/comprobantes/page.tsx`: sin restaurante activo se avisa; con
 * el módulo `accounting` apagado la página no existe (notFound). Reusa las
 * mismas funciones que las APIs de cierre y fiscal — nada de la regla de
 * negocio vive acá.
 */
export async function loadCierrePage(
  yearParam: string | string[] | undefined,
  now: Date = new Date(),
): Promise<CierrePageData | "no_restaurant"> {
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return "no_restaurant";
  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { enabledModules: true, country: true },
  });
  if (!tenant || !isModuleEnabled(tenant.enabledModules, "accounting")) {
    notFound();
  }

  const today = todayIso(now);
  const currentMonth = today.slice(0, 7);
  const currentYear = Number(today.slice(0, 4));
  const year = parseYearParam(yearParam, currentYear);

  const [currency, config, closing, counts, first] = await Promise.all([
    getCurrencyForCountry(tenant.country),
    getAccountingConfig(restaurantId),
    loadClosing(restaurantId, String(year)),
    countEntriesByMonth(restaurantId, year),
    firstEntryMonth(restaurantId),
  ]);

  return {
    currency,
    currentYear,
    config: {
      closedThrough: config.closedThrough,
      nextVoucherNumber: config.nextVoucherNumber,
    },
    status: buildYearStatus({
      year,
      closedThrough: config.closedThrough,
      counts,
      currentMonth,
      firstEntryMonth: first,
    }),
    closing,
  };
}
