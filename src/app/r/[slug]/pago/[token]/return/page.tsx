import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { formatMoney } from "@/lib/format";
import type { Locale } from "@/i18n/config";
import { fetchPseTokenStatus } from "@/lib/payments/pseStatus";
import { paymentLinkPath, settlePaymentLinkInTx } from "@/lib/paymentLinks";

export const dynamic = "force-dynamic";

/**
 * Retorno del banco (PSE) para un link de pago. Igual patrón que el
 * retorno del depósito de reserva: si el link sigue pendiente y tenemos
 * el token PSE en `providerRef`, consultamos /transfer/v1/status y
 * cerramos el link acá mismo — no dependemos del webhook.
 */
export default async function PayLinkReturnPage({
  params,
}: {
  params: Promise<{ slug: string; token: string }>;
}) {
  const { slug, token } = await params;
  const t = await getTranslations("payLink");
  const locale = (await getLocale()) as Locale;

  const link = await db.paymentLink.findUnique({
    where: { token },
    include: { restaurant: { select: { id: true, slug: true, name: true, kushkiMode: true } } },
  });
  if (!link || link.restaurant.slug !== slug) return notFound();

  let state: "approved" | "declined" | "pending" =
    link.status === "paid" ? "approved" : "pending";

  if (state === "pending" && link.status === "pending" && link.providerRef) {
    const result = await fetchPseTokenStatus({
      restaurant: { id: link.restaurant.id, kushkiMode: link.restaurant.kushkiMode },
      token: link.providerRef,
    });
    if (result === "approved") {
      await db.$transaction((tx) =>
        settlePaymentLinkInTx(
          tx,
          { id: link.id },
          { approved: true, providerRef: link.providerRef, method: "kushki_pse" },
        ),
      );
      state = "approved";
    } else {
      state = result;
    }
  }

  const amount = formatMoney(link.amountCents, { currency: link.currency, locale });
  const backHref = paymentLinkPath(slug, token);

  return (
    <main className="min-h-dvh bg-bone text-ink flex flex-col items-center justify-center px-6 py-12">
      <div className="max-w-sm w-full text-center">
        <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-muted mb-2">
          {t("returnEyebrow", { name: link.restaurant.name })}
        </div>

        {state === "approved" && (
          <>
            <div className="mx-auto w-14 h-14 rounded-full bg-[#2E6B4C]/15 text-[#1E5339] flex items-center justify-center text-2xl mb-4">
              {"✓"}
            </div>
            <h1 className="font-display text-3xl mb-2">{t("titlePaid")}</h1>
            <p className="text-sm text-muted mb-6">{t("paidBody", { amount })}</p>
            <Link href={backHref} className="text-sm text-terracotta hover:underline">
              {t("backToLink")}
            </Link>
          </>
        )}

        {state === "declined" && (
          <>
            <div className="text-5xl mb-3">{"✕"}</div>
            <h1 className="font-display text-2xl mb-2">{t("declinedTitle")}</h1>
            <p className="text-sm text-muted mb-6">{t("declinedBody")}</p>
            <Link
              href={backHref}
              className="inline-flex items-center justify-center h-10 px-5 rounded-full bg-ink text-bone text-sm font-medium"
            >
              {t("retry")}
            </Link>
          </>
        )}

        {state === "pending" && (
          <>
            <div className="text-5xl mb-3 animate-pulse">{"⏳"}</div>
            <h1 className="font-display text-2xl mb-2">{t("processing")}</h1>
            <p className="text-sm text-muted mb-1">{t("processingBody")}</p>
            <p className="text-xs text-muted mb-2">{t("pageAutoRefresh")}</p>
            <meta httpEquiv="refresh" content="3" />
          </>
        )}
      </div>
    </main>
  );
}
