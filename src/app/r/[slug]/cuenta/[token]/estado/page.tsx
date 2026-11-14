import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { displayOrderCode } from "@/lib/orderCode";
import { formatDate, formatMoney } from "@/lib/format";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import type { Locale } from "@/i18n/config";
import { manualInvoicePayLinkPath, payLinkState } from "@/lib/manualInvoicePayLink";
import { refreshReceivablePayLink } from "@/lib/manualInvoiceReceivable";
import { LocaleSwitcher } from "@/components/LocaleSwitcher";

export const dynamic = "force-dynamic";

/**
 * Estado de un LINK DE PAGO de factura manual: /r/[slug]/cuenta/[token]/estado.
 *
 * Acá aterriza quien abre un link que ya no cobra (la cuenta se pagó en
 * caja, se descartó, o el link venció) — la puerta de entrada
 * (`../route.ts`) lo manda para que lo lea sin un 404 pelado. Con la cuenta
 * todavía abierta ofrece volver a entrar. Un token que no es de este
 * comercio o no es de una factura manual no existe: 404.
 */
export default async function ManualInvoicePayLinkStatusPage({
  params,
}: {
  params: Promise<{ slug: string; token: string }>;
}) {
  const { slug, token } = await params;
  const t = await getTranslations("orderPayLink");
  const locale = (await getLocale()) as Locale;

  const link = await db.paymentLink.findUnique({
    where: { token },
    select: {
      id: true,
      restaurantId: true,
      status: true,
      kind: true,
      expiresAt: true,
      amountCents: true,
      creditPaymentId: true,
      restaurant: { select: { slug: true, name: true, country: true } },
      order: {
        select: {
          status: true,
          shortCode: true,
          subtotalCents: true,
          taxCents: true,
          discountCents: true,
          table: { select: { kind: true } },
          payments: { where: { status: "approved" }, select: { amountCents: true, tipCents: true } },
        },
      },
    },
  });
  if (!link || link.kind !== "order" || !link.order || link.restaurant.slug !== slug || link.order.table.kind !== "manual") {
    return notFound();
  }

  const currency = await getCurrencyForCountry(link.restaurant.country);
  // Factura emitida por cobrar: el estado y el saldo salen de su cargo a
  // crédito, no de la orden (que ya está cerrada).
  const receivable = link.creditPaymentId ? await refreshReceivablePayLink(link) : null;
  const paidFood = link.order.payments.reduce((s, p) => s + Math.max(0, p.amountCents - p.tipCents), 0);
  const outstandingCents = receivable
    ? receivable.amountCents
    : Math.max(0, link.order.subtotalCents + link.order.taxCents - link.order.discountCents - paidFood);
  const amount = formatMoney(outstandingCents, { currency, locale });
  const code = displayOrderCode(link.order.shortCode);
  const state = receivable ? receivable.state : payLinkState(link, link.order);

  const header = (
    <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-muted mb-2">
      {t("eyebrow", { name: link.restaurant.name, code })}
    </div>
  );

  if (state === "paid") {
    return (
      <Shell>
        {header}
        <div className="mx-auto w-14 h-14 rounded-full bg-[#2E6B4C]/15 text-[#1E5339] flex items-center justify-center text-2xl mb-4">
          {"✓"}
        </div>
        <h1 className="font-display text-3xl mb-2">{t("titlePaid")}</h1>
        <p className="text-sm text-muted">{t("paidBody")}</p>
      </Shell>
    );
  }

  if (state === "cancelled") {
    return (
      <Shell>
        {header}
        <h1 className="font-display text-2xl mb-2">{t("titleCancelled")}</h1>
        <p className="text-sm text-muted">{t("cancelledBody")}</p>
      </Shell>
    );
  }

  if (state === "expired") {
    return (
      <Shell>
        {header}
        <h1 className="font-display text-2xl mb-2">{t("titleExpired")}</h1>
        <p className="text-sm text-muted">
          {t("expiredBody", {
            date: formatDate(link.expiresAt ?? new Date(), { locale, dateStyle: "long", timeStyle: undefined }),
          })}
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      {header}
      <h1 className="font-display text-3xl mb-1">{t("titleOpen")}</h1>
      <p className="text-sm text-muted mb-6">{t("openBody")}</p>
      <div className="rounded-2xl border border-hairline bg-paper p-4 mb-6 text-left">
        <div className="font-mono text-[10px] tracking-wider uppercase text-muted">{t("amountLabel")}</div>
        <div className="font-display text-3xl tracking-wide mt-1">{amount}</div>
      </div>
      <Link href={manualInvoicePayLinkPath(slug, token)} className="mp-pay mp-pay--ink">
        {t("payCta", { amount })}
      </Link>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-dvh bg-bone text-ink flex flex-col items-center justify-center px-6 py-12">
      <div className="max-w-sm w-full text-center">{children}</div>
      <div className="mt-8">
        <LocaleSwitcher />
      </div>
    </main>
  );
}
