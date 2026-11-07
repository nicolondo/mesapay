import Link from "next/link";
import { getTranslations } from "next-intl/server";
import {
  getKushkiMode,
  getBillingCredentials,
  getBillingWebhookSecret,
} from "@/lib/platformConfig";
import { db } from "@/lib/db";
import { KushkiModeSwitcher } from "../KushkiModeSwitcher";
import { KushkiBillingKeysCard } from "../KushkiBillingKeysCard";
import { CrmCountriesCard } from "../CrmCountriesCard";
import { MenuAiCard } from "./MenuAiCard";
import { getMenuAiStatus } from "@/lib/menuAiConfig";
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
  const menuAi = await getMenuAiStatus();
  const [kushkiMode, billing, webhookSecret] = await Promise.all([
    getKushkiMode(),
    getBillingCredentials(),
    getBillingWebhookSecret(),
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
    <div className="mp-page mp-page--narrow">
      <h1 className="mp-page-title mb-2">{t("configTitle")}</h1>
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
          initialHasWebhookSecret={webhookSecret !== null}
        />
      </section>

      <section className="mb-6 rounded-2xl border border-op-border bg-op-surface p-5">
        <h2 className="font-display text-xl">{t("navWallet")}</h2>
        <p className="mt-2 text-sm text-op-muted">{t("walletConfigHint")}</p>
        <Link href="/admin/wallet" className="mt-4 inline-flex min-h-11 items-center rounded-full bg-ink px-5 py-2 text-sm text-bone">{t("walletConfigLink")}</Link>
      </section>

      <section className="mb-6"><MenuAiCard initial={menuAi} /></section>

      <section className="mb-6">
        <CrmCountriesCard initialCountries={initialCountries} />
      </section>
    </div>
  );
}
