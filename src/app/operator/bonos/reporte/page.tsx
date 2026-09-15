import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { isModuleEnabled } from "@/lib/modules";
import { dayRange, loadVoucherReport } from "@/lib/vouchers/statement";
import { ReporteClient, type StatementRow } from "./ReporteClient";

export const dynamic = "force-dynamic";

const BOGOTA_OFFSET_MS = 5 * 60 * 60 * 1000;

/** Hoy en Bogotá como "YYYY-MM-DD". */
function bogotaDay(d: Date): string {
  return new Date(d.getTime() - BOGOTA_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Reporte de bonos usados y corte. Filtro por empresa y rango de días
 * (Bogotá); tabla de redenciones con lo pendiente de corte marcado;
 * "Cerrar corte" agrupa lo no cortado de la empresa elegida y le manda
 * el resumen (con link de pago si hay crédito). Gate estricto por
 * módulo `vouchers`.
 */
export default async function ReportePage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string; from?: string; to?: string }>;
}) {
  const t = await getTranslations("opVouchers");
  const tSettings = await getTranslations("opSettings");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{tSettings("noRestaurant")}</div>;

  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { name: true, enabledModules: true, country: true },
  });
  if (!tenant || !isModuleEnabled(tenant.enabledModules, "vouchers")) notFound();
  const currency = await getCurrencyForCountry(tenant.country);

  const sp = await searchParams;
  const today = bogotaDay(new Date());
  const monthStart = today.slice(0, 8) + "01";
  const from = sp.from && dayRange(sp.from, sp.from) ? sp.from : monthStart;
  const to = sp.to && dayRange(sp.to, sp.to) ? sp.to : today;
  const range = dayRange(from, to) ?? dayRange(monthStart, today)!;
  const customer = sp.customer?.trim() || null;

  const [customers, rows, statements] = await Promise.all([
    db.billingCustomer.findMany({
      where: { restaurantId, voucherBatches: { some: {} } },
      orderBy: { customerName: "asc" },
      select: { id: true, customerName: true },
    }),
    loadVoucherReport({ restaurantId, billingCustomerId: customer, from: range.from, to: range.to }),
    db.voucherStatement.findMany({
      where: { restaurantId, ...(customer ? { billingCustomerId: customer } : {}) },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        createdAt: true,
        periodFrom: true,
        periodTo: true,
        totalCents: true,
        creditCents: true,
        redemptionCount: true,
        status: true,
        emailSentAt: true,
        billingCustomer: { select: { customerName: true } },
      },
    }),
  ]);

  const statementRows: StatementRow[] = statements.map((s) => ({
    id: s.id,
    createdAt: s.createdAt.toISOString(),
    periodFrom: s.periodFrom.toISOString(),
    periodTo: new Date(s.periodTo.getTime() - 1).toISOString(),
    totalCents: s.totalCents,
    creditCents: s.creditCents,
    redemptionCount: s.redemptionCount,
    status: s.status,
    emailSentAt: s.emailSentAt?.toISOString() ?? null,
    customerName: s.billingCustomer.customerName,
  }));

  return (
    <div className="mp-page">
      <header className="mp-page-header">
        <div>
          <p className="mp-eyebrow">{tenant.name}</p>
          <h1 className="mp-page-title">{t("reportTitle")}</h1>
          <p className="mp-page-description">{t("reportIntro")}</p>
        </div>
      </header>
      <ReporteClient
        currency={currency}
        customers={customers}
        filter={{ customer, from, to }}
        rows={rows.map((r) => ({ ...r, redeemedAt: r.redeemedAt.toISOString() }))}
        statements={statementRows}
      />
    </div>
  );
}
