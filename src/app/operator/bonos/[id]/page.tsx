import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { formatDate, formatMoney } from "@/lib/format";
import type { Locale } from "@/i18n/config";
import { isModuleEnabled } from "@/lib/modules";
import { appOrigin, paymentLinkPath } from "@/lib/paymentLinks";
import { formatVoucherCode } from "@/lib/vouchers/code";
import { voucherRedeemability } from "@/lib/vouchers/validate";
import { StatusBadge } from "../BonosClient";
import { BatchDetailClient, type VoucherRow } from "./BatchDetailClient";

export const dynamic = "force-dynamic";

/**
 * Detalle de un lote: resumen, link de pago (prepago), correo, y la tabla
 * de bonos con código, saldo y estado, con cancelación bono a bono o del
 * lote entero. El lote de OTRO comercio es un 404 (el where lleva el
 * restaurantId de la sesión).
 */
export default async function BatchDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const t = await getTranslations("opVouchers");
  const tSettings = await getTranslations("opSettings");
  const locale = (await getLocale()) as Locale;
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{tSettings("noRestaurant")}</div>;

  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { slug: true, enabledModules: true, country: true },
  });
  if (!tenant || !isModuleEnabled(tenant.enabledModules, "vouchers")) notFound();

  const batch = await db.voucherBatch.findFirst({
    where: { id, restaurantId },
    include: {
      billingCustomer: { select: { customerName: true, email: true } },
      issuedBy: { select: { name: true, email: true } },
      paymentLink: { select: { token: true, status: true, paidAt: true } },
      vouchers: {
        orderBy: { code: "asc" },
        select: {
          id: true,
          code: true,
          valueCents: true,
          balanceCents: true,
          status: true,
          expiresAt: true,
          _count: { select: { redemptions: true } },
        },
      },
    },
  });
  if (!batch) notFound();

  const currency = await getCurrencyForCountry(tenant.country);
  const money = (cents: number) => formatMoney(cents, { currency, locale });
  const date = (d: Date | string) =>
    formatDate(d, { locale, dateStyle: "medium", timeStyle: undefined });

  const rows: VoucherRow[] = batch.vouchers.map((v) => ({
    id: v.id,
    code: formatVoucherCode(v.code),
    valueCents: v.valueCents,
    balanceCents: v.balanceCents,
    status: v.status,
    redeemability: voucherRedeemability(v, batch),
    used: v._count.redemptions > 0 || v.balanceCents !== v.valueCents,
    expiresAt: v.expiresAt?.toISOString() ?? null,
  }));
  const redeemedCents = batch.vouchers
    .filter((v) => v.status !== "cancelled")
    .reduce((s, v) => s + (v.valueCents - v.balanceCents), 0);
  const balanceCents = batch.vouchers
    .filter((v) => v.status === "active")
    .reduce((s, v) => s + v.balanceCents, 0);
  const anyUsed = rows.some((r) => r.used);
  const paymentUrl =
    batch.paymentLink && batch.mode === "prepaid"
      ? `${appOrigin()}${paymentLinkPath(tenant.slug, batch.paymentLink.token)}`
      : null;

  return (
    <div className="mp-page">
      <header className="mp-page-header">
        <div>
          <Link href="/operator/bonos" className="mp-eyebrow hover:underline">
            {t("backToList")}
          </Link>
          <h1 className="mp-page-title">{t("batchTitle", { date: date(batch.issuedAt) })}</h1>
          <p className="mp-page-description">
            {t("batchFor", { customer: batch.billingCustomer.customerName })}
            {" · "}
            {batch.billingCustomer.email}
          </p>
        </div>
        <StatusBadge mode={batch.mode} status={batch.status} />
      </header>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Stat label={t("colVouchers")} value={`${batch.quantity}`} />
        <Stat label={t("colUnit")} value={money(batch.unitValueCents)} />
        <Stat label={t("redeemedTotal")} value={money(redeemedCents)} />
        <Stat label={t("colBalance")} value={money(balanceCents)} />
      </section>

      <section className="rounded-2xl border border-op-border bg-op-surface p-5 mb-6 text-sm space-y-2">
        <div>
          <span className="text-op-muted">{t("colMode")}: </span>
          {batch.mode === "prepaid" ? t("modePrepaid") : t("modeCredit")}
        </div>
        <div>
          <span className="text-op-muted">{t("colExpires")}: </span>
          {batch.expiresAt ? date(batch.expiresAt) : t("expiryNone")}
        </div>
        {batch.issuedBy && (
          <div>
            <span className="text-op-muted">{t("issuedBy")}: </span>
            {batch.issuedBy.name ?? batch.issuedBy.email}
          </div>
        )}
        {batch.note && (
          <div>
            <span className="text-op-muted">{t("noteLabel")}: </span>
            {batch.note}
          </div>
        )}
        {batch.mode === "prepaid" && batch.paidAt && (
          <div>
            <span className="text-op-muted">{t("paidAt")}: </span>
            {date(batch.paidAt)}
          </div>
        )}
      </section>

      <BatchDetailClient
        batchId={batch.id}
        mode={batch.mode}
        status={batch.status}
        currency={currency}
        paymentUrl={batch.status === "issued" ? paymentUrl : null}
        emailSentAt={batch.emailSentAt?.toISOString() ?? null}
        anyUsed={anyUsed}
        vouchers={rows}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-op-border bg-op-surface p-4">
      <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">{label}</div>
      <div className="font-display text-2xl tabular-nums mt-1">{value}</div>
    </div>
  );
}
