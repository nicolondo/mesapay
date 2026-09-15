import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { isModuleEnabled } from "@/lib/modules";
import { BonosClient, type BatchRow } from "./BonosClient";

export const dynamic = "force-dynamic";

/**
 * Bonos empresariales: emisión de lotes a una empresa (BillingCustomer)
 * y lista de lotes con su estado. Gate estricto por módulo `vouchers`:
 * apagado, la página no existe (notFound) y la nav tampoco la muestra.
 */
export default async function BonosPage() {
  const t = await getTranslations("opVouchers");
  const tSettings = await getTranslations("opSettings");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{tSettings("noRestaurant")}</div>;

  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: {
      name: true,
      enabledModules: true,
      country: true,
      voucherSettings: {
        select: { mode: true, defaultValueCents: true, defaultExpiryDays: true },
      },
    },
  });
  if (!tenant || !isModuleEnabled(tenant.enabledModules, "vouchers")) notFound();
  const currency = await getCurrencyForCountry(tenant.country);

  const batches = await db.voucherBatch.findMany({
    where: { restaurantId },
    orderBy: { issuedAt: "desc" },
    take: 200,
    select: {
      id: true,
      mode: true,
      status: true,
      quantity: true,
      unitValueCents: true,
      expiresAt: true,
      issuedAt: true,
      emailSentAt: true,
      billingCustomer: { select: { customerName: true } },
      vouchers: { select: { balanceCents: true, status: true } },
    },
  });

  const rows: BatchRow[] = batches.map((b) => ({
    id: b.id,
    mode: b.mode,
    status: b.status,
    quantity: b.quantity,
    unitValueCents: b.unitValueCents,
    totalCents: b.quantity * b.unitValueCents,
    balanceCents: b.vouchers
      .filter((v) => v.status === "active" || v.status === "exhausted")
      .reduce((s, v) => s + v.balanceCents, 0),
    activeCount: b.vouchers.filter((v) => v.status === "active").length,
    expiresAt: b.expiresAt?.toISOString() ?? null,
    issuedAt: b.issuedAt.toISOString(),
    emailSentAt: b.emailSentAt?.toISOString() ?? null,
    customerName: b.billingCustomer.customerName,
  }));

  return (
    <div className="mp-page">
      <header className="mp-page-header">
        <div>
          <p className="mp-eyebrow">{tenant.name}</p>
          <h1 className="mp-page-title">{t("title")}</h1>
          <p className="mp-page-description">{t("intro")}</p>
        </div>
      </header>
      <BonosClient
        currency={currency}
        settings={{
          mode: tenant.voucherSettings?.mode ?? "prepaid",
          defaultValueCents: tenant.voucherSettings?.defaultValueCents ?? 0,
          defaultExpiryDays: tenant.voucherSettings?.defaultExpiryDays ?? null,
        }}
        batches={rows}
      />
    </div>
  );
}
