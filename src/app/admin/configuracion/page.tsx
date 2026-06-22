import { getTranslations } from "next-intl/server";
import { getKushkiMode, getBillingCredentials } from "@/lib/platformConfig";
import { db } from "@/lib/db";
import { KushkiModeSwitcher } from "../KushkiModeSwitcher";
import { KushkiBillingKeysCard } from "../KushkiBillingKeysCard";
import { CrmCountriesCard } from "../CrmCountriesCard";
import coData from "@/data/cities/co.json";
import mxData from "@/data/cities/mx.json";

export const dynamic = "force-dynamic";

const DATASETS: Record<string, { name: string; datasetSize: number }> = {
  CO: { name: "Colombia", datasetSize: (coData as { cities: string[] }).cities.length },
  MX: { name: "México", datasetSize: (mxData as { cities: string[] }).cities.length },
};

/**
 * Configuración global de plataforma. Modo Kushki + países CRM.
 */
export default async function AdminConfiguracionPage() {
  const t = await getTranslations("opAdmin");
  const [kushkiMode, billing] = await Promise.all([
    getKushkiMode(),
    getBillingCredentials(),
  ]);

  // Load country state (enabled + currency) for the card.
  const [dbCountries, cityCounts] = await Promise.all([
    db.crmCountry.findMany({ select: { code: true, enabled: true, currency: true } }),
    db.crmCity.groupBy({ by: ["countryCode"], _count: { id: true } }),
  ]);
  const dbMap = new Map(dbCountries.map((c) => [c.code, c]));
  const countMap = new Map(cityCounts.map((c) => [c.countryCode, c._count.id]));
  const initialCountries = Object.entries(DATASETS).map(([code, ds]) => ({
    code,
    name: ds.name,
    enabled: dbMap.get(code)?.enabled ?? false,
    currency: dbMap.get(code)?.currency ?? (code === "MX" ? "MXN" : "COP"),
    cityCount: countMap.get(code) ?? 0,
    datasetSize: ds.datasetSize,
  }));

  return (
    <div className="p-6 max-w-5xl mx-auto w-full">
      <div className="font-display text-3xl mb-1">{t("configTitle")}</div>
      <p className="text-sm text-op-muted mb-6">
        {t("configIntro")}
      </p>

      <section className="mb-6">
        <KushkiModeSwitcher initialMode={kushkiMode} />
      </section>

      <section className="mb-6">
        <KushkiBillingKeysCard
          initialPublicKey={billing.publicKey}
          initialHasPrivateKey={billing.privateKey !== null}
        />
      </section>

      <section className="mb-6">
        <CrmCountriesCard initialCountries={initialCountries} />
      </section>
    </div>
  );
}
