import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { resolveEnabledPaymentMethods } from "@/lib/paymentMethods";
import { DatafonosClient } from "./DatafonosClient";
import { env } from "@/lib/env";
import { businessCodeProblem, maskBusinessCode } from "@/lib/payments/businessCode";

export const dynamic = "force-dynamic";

export default async function DatafonosSettingsPage() {
  const t = await getTranslations("opSettings");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{t("noRestaurant")}</div>;

  const [restaurant, devices] = await Promise.all([
    db.restaurant.findUnique({
      where: { id: restaurantId },
      select: {
        cloudTerminalBusinessCode: true,
        enabledPaymentMethods: true,
        kushkiMerchantId: true,
        kushkiPublicKey: true,
      },
    }),
    db.terminalDevice.findMany({
      where: { restaurantId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        label: true,
        kushkiDeviceId: true,
        serialNumber: true,
        active: true,
        lastSeenAt: true,
      },
    }),
  ]);

  // Esta pantalla solo aplica si el comercio tiene activado el cobro por
  // datáfono Kushki. Si no, no hay nada que configurar acá → volver a ajustes.
  if (
    !restaurant ||
    !resolveEnabledPaymentMethods(restaurant.enabledPaymentMethods).includes(
      "kushki_card_terminal",
    )
  ) {
    redirect("/operator/settings");
  }

  return (
    <div className="p-6 max-w-3xl mx-auto w-full">
      <Link
        href="/operator/settings"
        className="font-mono text-[11px] tracking-[0.14em] uppercase text-op-muted hover:text-ink"
      >
        {t("backToSettings")}
      </Link>
      <div className="font-display text-3xl mt-2 mb-1">
        {t("datafonosTitle")}
      </div>
      <p className="text-sm text-op-muted mb-6">{t("datafonosIntro")}</p>

      {devices.length === 0 && (
        <div className="rounded-2xl border border-dashed border-op-border bg-op-surface p-6 text-center text-sm text-op-muted mb-3">
          {t("datafonosEmpty")}
        </div>
      )}
      <DatafonosClient
        // El Business-Code es la clave de cada cobro: al navegador va sólo
        // enmascarado. Sin uno propio, el cobro usa el de la plataforma
        // (`KUSHKI_BP_BUSINESS_CODE`, igual que terminal/charge), y la
        // pantalla lo dice en vez de mostrar el campo vacío.
        businessCode={{
          masked: maskBusinessCode(restaurant.cloudTerminalBusinessCode),
          platformMasked: restaurant.cloudTerminalBusinessCode
            ? null
            : maskBusinessCode(env.KUSHKI_BP_BUSINESS_CODE),
          // El que de verdad firma los cobros (el propio o el de la
          // plataforma): si es el Merchant ID o la llave pública, cada cobro
          // rebota con CLOUDPAYMENT_VALIDATION_ERROR, y la pantalla lo dice.
          problem: businessCodeProblem(
            restaurant.cloudTerminalBusinessCode || env.KUSHKI_BP_BUSINESS_CODE,
            restaurant,
          ),
        }}
        initial={devices.map((d) => ({
          id: d.id,
          label: d.label,
          kushkiDeviceId: d.kushkiDeviceId,
          serialNumber: d.serialNumber,
          active: d.active,
          lastSeenAt: d.lastSeenAt ? d.lastSeenAt.toISOString() : null,
        }))}
      />
    </div>
  );
}
