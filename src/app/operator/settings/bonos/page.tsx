import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { isModuleEnabled } from "@/lib/modules";
import { VoucherSettingsClient } from "./VoucherSettingsClient";

export const dynamic = "force-dynamic";

/**
 * Configuración → Bonos empresariales: modo de cobro (prepago / crédito),
 * valor y vigencia por defecto. Gate estricto por módulo `vouchers`: con
 * el módulo apagado la página no existe (notFound), igual que la tarjeta
 * del hub y la entrada de la nav.
 */
export default async function BonosSettingsPage() {
  const t = await getTranslations("opVouchers");
  const tSettings = await getTranslations("opSettings");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return <div className="p-6">{tSettings("noRestaurant")}</div>;
  }
  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: {
      enabledModules: true,
      country: true,
      voucherSettings: {
        select: { mode: true, defaultValueCents: true, defaultExpiryDays: true },
      },
    },
  });
  if (!tenant || !isModuleEnabled(tenant.enabledModules, "vouchers")) notFound();
  const currency = await getCurrencyForCountry(tenant.country);

  return (
    <div className="p-6 max-w-2xl mx-auto w-full">
      <Link
        href="/operator/settings"
        className="font-mono text-[11px] tracking-[0.14em] uppercase text-op-muted hover:text-ink"
      >
        {tSettings("backToSettings")}
      </Link>
      <div className="font-display text-3xl mt-2 mb-1">{t("settingsTitle")}</div>
      <p className="text-sm text-op-muted mb-6">{t("settingsIntro")}</p>

      <div className="space-y-6">
        <VoucherSettingsClient
          currency={currency}
          initial={{
            mode: tenant.voucherSettings?.mode ?? "prepaid",
            defaultValueCents: tenant.voucherSettings?.defaultValueCents ?? 0,
            defaultExpiryDays: tenant.voucherSettings?.defaultExpiryDays ?? null,
          }}
        />

        <section className="rounded-2xl border border-op-border bg-op-surface p-5">
          <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-3">
            {t("modesKicker")}
          </div>
          <dl className="space-y-3">
            <div>
              <dt className="text-sm font-medium">{t("modePrepaid")}</dt>
              <dd className="text-xs text-op-muted">{t("modePrepaidHelp")}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium">{t("modeCredit")}</dt>
              <dd className="text-xs text-op-muted">{t("modeCreditHelp")}</dd>
            </div>
          </dl>
          <p className="text-xs text-op-muted mt-4">{t("modeChangeNote")}</p>
        </section>

        <div
          className="rounded-xl border border-[#C98A2E]/40 bg-[#C98A2E]/10 p-3 text-sm text-[#8F6828]"
          role="note"
        >
          {t("fiscalPendingNote")}
        </div>

        <Link href="/operator/bonos" className="inline-block text-xs text-terracotta underline">
          {t("goIssue")}
        </Link>
      </div>
    </div>
  );
}
