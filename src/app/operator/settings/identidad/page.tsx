import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { IdentidadClient } from "./IdentidadClient";
import { LegalEntityPicker } from "./LegalEntityPicker";

export const dynamic = "force-dynamic";

export default async function IdentidadPage() {
  const t = await getTranslations("opIdentity");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{t("noRestaurant")}</div>;

  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: {
      name: true,
      logoUrl: true,
      legalName: true,
      taxId: true,
      legalAddress: true,
      legalCity: true,
      legalPhone: true,
      dianResolution: true,
      dianResolutionFrom: true,
      dianResolutionTo: true,
      dianResolutionDate: true,
      invoicePrefix: true,
      invoiceNextNumber: true,
      groupId: true,
      legalEntityId: true,
    },
  });
  if (!tenant) return <div className="p-6">{t("restaurantNotFound")}</div>;

  // Si pertenece a un grupo, traemos las razones sociales disponibles
  // para que el picker arriba del form deje al operador elegir.
  const groupLegalEntities = tenant.groupId
    ? await db.legalEntity.findMany({
        where: { groupId: tenant.groupId },
        orderBy: { name: "asc" },
        select: { id: true, name: true, taxId: true },
      })
    : [];

  return (
    <div className="p-6 max-w-2xl mx-auto w-full">
      <Link
        href="/operator/settings"
        className="text-sm text-op-muted hover:underline"
      >
        {"← "}
        {t("breadcrumbSettings")}
      </Link>
      <div className="font-display text-3xl mt-2 mb-1">{t("title")}</div>
      <p className="text-sm text-op-muted mb-6">{t("intro")}</p>

      {tenant.groupId && (
        <LegalEntityPicker
          options={groupLegalEntities}
          initialLegalEntityId={tenant.legalEntityId}
        />
      )}

      <IdentidadClient
        initial={{
          name: tenant.name,
          logoUrl: tenant.logoUrl,
          legalName: tenant.legalName,
          taxId: tenant.taxId,
          legalAddress: tenant.legalAddress,
          legalCity: tenant.legalCity,
          legalPhone: tenant.legalPhone,
          dianResolution: tenant.dianResolution,
          dianResolutionFrom: tenant.dianResolutionFrom,
          dianResolutionTo: tenant.dianResolutionTo,
          dianResolutionDate: tenant.dianResolutionDate
            ? tenant.dianResolutionDate.toISOString().slice(0, 10)
            : null,
          invoicePrefix: tenant.invoicePrefix,
          invoiceNextNumber: tenant.invoiceNextNumber,
        }}
      />
    </div>
  );
}
