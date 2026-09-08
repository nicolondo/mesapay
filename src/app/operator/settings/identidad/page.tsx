import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import {
  municipioLabel,
  suggestMunicipioFromText,
} from "@/lib/dane/municipios";
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
      legalCityCode: true,
      legalPhone: true,
      country: true,
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

  // El selector DANE es de Colombia: DIVIPOLA no existe en México ni en
  // Brasil, y ofrecerle municipios colombianos a un comercio mexicano
  // sería peor que no ofrecer nada. country es nulable en comercios
  // viejos y MESAPAY nació en Colombia, así que null cuenta como CO.
  const usaDane = tenant.country == null || tenant.country === "CO";

  // Comercio que ya existe: tiene legalCity en texto libre y ningún
  // código. Si el texto coincide EXACTO con un único municipio,
  // ofrecemos ese como SUGERENCIA para que el operador la confirme con
  // un click. Nunca se guarda sola: un match equivocado manda las
  // facturas al municipio de otro lado, que es justo lo que queremos
  // evitar. Si el texto es ambiguo ("Providencia") no sugerimos nada y
  // el operador busca el municipio.
  const cityHint =
    usaDane && !tenant.legalCityCode
      ? suggestMunicipioFromText(tenant.legalCity)
      : null;

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
        usaDane={usaDane}
        cityHint={
          cityHint
            ? { code: cityHint.code, label: municipioLabel(cityHint) }
            : null
        }
        initial={{
          name: tenant.name,
          logoUrl: tenant.logoUrl,
          legalName: tenant.legalName,
          taxId: tenant.taxId,
          legalAddress: tenant.legalAddress,
          legalCity: tenant.legalCity,
          legalCityCode: tenant.legalCityCode,
          legalPhone: tenant.legalPhone,
        }}
      />
    </div>
  );
}
