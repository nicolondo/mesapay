import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { formatMoney } from "@/lib/format";
import type { Locale } from "@/i18n/config";
import { isModuleEnabled } from "@/lib/modules";
import { getPaymentProvider } from "@/lib/payments";
import {
  DEPOSIT_CAPABLE_SLUGS,
  resolveEnabledPaymentMethods,
} from "@/lib/paymentMethods";
import { paymentLinkIsOpen } from "@/lib/paymentLinks";
import { getRestaurantKushkiMode } from "@/lib/platformConfig";
import { LocaleSwitcher } from "@/components/LocaleSwitcher";
import { PayLinkClient } from "./PayLinkClient";

export const dynamic = "force-dynamic";

/**
 * Página pública de un LINK DE PAGO: /r/[slug]/pago/[token]. Le llega a
 * la empresa por correo (emisión de bonos prepagados; corte a crédito).
 * Muestra qué se cobra y ofrece tarjeta / Apple Pay / PSE según los
 * medios online que el comercio tenga habilitados. Pagado, cancelado o
 * vencido: lo dice y no cobra.
 */
export default async function PayLinkPage({
  params,
}: {
  params: Promise<{ slug: string; token: string }>;
}) {
  const { slug, token } = await params;
  const t = await getTranslations("payLink");
  const locale = (await getLocale()) as Locale;

  const tenant = await db.restaurant.findUnique({
    where: { slug },
    select: {
      id: true,
      name: true,
      legalCity: true,
      country: true,
      kushkiPublicKey: true,
      kushkiOnboardingStatus: true,
      kushkiMode: true,
      enabledPaymentMethods: true,
      enabledModules: true,
    },
  });
  if (!tenant) return notFound();

  const link = await db.paymentLink.findUnique({
    where: { token },
    include: {
      voucherBatch: {
        select: {
          quantity: true,
          unitValueCents: true,
          billingCustomer: { select: { customerName: true } },
        },
      },
    },
  });
  if (!link || link.restaurantId !== tenant.id) return notFound();
  // Un link de bonos con el módulo apagado no cobra: la pantalla no existe.
  if (link.kind.startsWith("voucher_") && !isModuleEnabled(tenant.enabledModules, "vouchers")) {
    return notFound();
  }

  const currency = link.currency || (await getCurrencyForCountry(tenant.country));
  const amount = formatMoney(link.amountCents, { currency, locale });
  const concept =
    link.kind === "voucher_batch" && link.voucherBatch
      ? t("conceptVoucherBatch", {
          count: link.voucherBatch.quantity,
          value: formatMoney(link.voucherBatch.unitValueCents, { currency, locale }),
          customer: link.voucherBatch.billingCustomer.customerName,
        })
      : t("conceptGeneric");

  const header = (
    <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-muted mb-2">
      {t("eyebrow", { name: tenant.name })}
    </div>
  );

  if (link.status === "paid") {
    return (
      <Shell>
        {header}
        <div className="mx-auto w-14 h-14 rounded-full bg-[#2E6B4C]/15 text-[#1E5339] flex items-center justify-center text-2xl mb-4">
          {"✓"}
        </div>
        <h1 className="font-display text-3xl mb-2">{t("titlePaid")}</h1>
        <p className="text-sm text-muted mb-1">{t("paidBody", { amount })}</p>
        <p className="text-sm text-muted">{concept}</p>
        {link.kind === "voucher_batch" && (
          <p className="text-xs text-muted mt-4">{t("paidVoucherNote")}</p>
        )}
      </Shell>
    );
  }

  if (!paymentLinkIsOpen(link)) {
    return (
      <Shell>
        {header}
        <h1 className="font-display text-2xl mb-2">{t("titleClosed")}</h1>
        <p className="text-sm text-muted">{t("closedBody")}</p>
      </Shell>
    );
  }

  const kushkiMode = await getRestaurantKushkiMode(tenant);
  const onboarded = tenant.kushkiOnboardingStatus === "active" || kushkiMode === "mock";
  const methods = onboarded
    ? resolveEnabledPaymentMethods(tenant.enabledPaymentMethods).filter((m) =>
        DEPOSIT_CAPABLE_SLUGS.includes(m),
      )
    : [];

  // Bancos PSE pre-cargados (cacheados 1h en la API) — best-effort.
  let pseBanks: { code: string; name: string }[] = [];
  if (methods.includes("kushki_pse") && tenant.kushkiPublicKey) {
    try {
      const provider = await getPaymentProvider(kushkiMode);
      pseBanks = await provider.listPseBanks(tenant.kushkiPublicKey);
    } catch (err) {
      console.error("[pay-link] prefetch pse banks", err);
    }
  }

  return (
    <Shell wide>
      {header}
      <h1 className="font-display text-3xl mb-1">{t("titlePending")}</h1>
      <p className="text-sm text-muted mb-6">{concept}</p>
      <div className="rounded-2xl border border-hairline bg-paper p-4 mb-6 text-left">
        <div className="font-mono text-[10px] tracking-wider uppercase text-muted">
          {t("amountLabel")}
        </div>
        <div className="font-display text-3xl tracking-wide mt-1">{amount}</div>
      </div>
      <PayLinkClient
        tenantSlug={slug}
        tenantName={tenant.name}
        token={token}
        amountCents={link.amountCents}
        amountLabel={amount}
        methods={methods}
        kushkiPublicKey={tenant.kushkiPublicKey}
        kushkiMode={kushkiMode}
        currency={currency === "MXN" ? "MXN" : "COP"}
        pseBanks={pseBanks}
      />
    </Shell>
  );
}

function Shell({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <main className="min-h-dvh bg-bone text-ink flex flex-col items-center justify-center px-6 py-12">
      <div className={`${wide ? "max-w-md" : "max-w-sm"} w-full text-center`}>{children}</div>
      <div className="mt-8">
        <LocaleSwitcher />
      </div>
    </main>
  );
}
