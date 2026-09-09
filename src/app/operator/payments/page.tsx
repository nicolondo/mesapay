import Link from "next/link";
import type { Prisma, PaymentStatus } from "@prisma/client";
import { Icon } from "@/components/ui/Icon";
import { getTranslations, getLocale } from "next-intl/server";
import { db } from "@/lib/db";
import { fmtCOP } from "@/lib/format";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getMeseroScope } from "@/lib/meseroScope";
import { PaymentDetailSheet, type PaymentDetail } from "./PaymentDetailSheet";

export const dynamic = "force-dynamic";

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; page?: string }>;
}) {
  const t = await getTranslations("opPayments");
  const ux = await getTranslations("workspaceUi");
  const locale = await getLocale();
  const sp = await searchParams;
  const q = (sp.q ?? "").trim().slice(0, 80);
  const statuses = ["pending", "approved", "declined", "refunded"] as const;
  const status =
    sp.status === "review" || statuses.includes(sp.status as PaymentStatus)
      ? sp.status!
      : "all";
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{t("noRestaurant")}</div>;

  // Mesero-scoped users only see payments for orders on their tables.
  // Other roles see everything.
  const scope = await getMeseroScope();
  const tableFilter = scope.scoped
    ? { table: { number: { in: scope.tableNumbers ?? [] } } }
    : {};

  const where: Prisma.PaymentWhereInput = {
    order: {
      restaurantId,
      ...tableFilter,
      ...(q ? { shortCode: { contains: q, mode: "insensitive" } } : {}),
    },
    ...(status === "review"
      ? { reconciliationRequired: true }
      : status !== "all"
        ? { status: status as PaymentStatus }
        : {}),
  };
  const count = await db.payment.count({ where });
  const lastPage = Math.max(1, Math.ceil(count / 50));
  const page = Math.min(
    lastPage,
    Math.max(1, Math.trunc(Number(sp.page) || 1)),
  );
  const pageHref = (next: number) =>
    `/operator/payments?${new URLSearchParams({ q, status, page: String(next) })}`;
  const [tenant, paymentRows] = await Promise.all([
    db.restaurant.findUnique({
      where: { id: restaurantId },
      select: { name: true, serviceMode: true },
    }),
    db.payment.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * 50,
      take: 51,
      include: {
        order: { include: { table: true } },
        // El charge de Kushki trae los datos ricos de la tarjeta (marca,
        // últimos 4, código de aprobación...). Tomamos el más reciente.
        kushkiTransactions: {
          where: { kind: "charge" },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    }),
  ]);
  const payments = paymentRows.slice(0, 50);
  const hasNext = paymentRows.length > 50;
  const counterMode = tenant?.serviceMode === "counter";

  // Arma el objeto de detalle para el drawer a partir del charge de Kushki.
  // Devuelve null si el pago no tiene datos de tarjeta (efectivo, PSE, etc.).
  const buildDetail = (p: (typeof payments)[number]): PaymentDetail | null => {
    const tx = p.kushkiTransactions[0];
    if (!tx || (!tx.cardBrand && !tx.cardLast4)) return null;
    return {
      shortCode: p.order.shortCode,
      methodLabel: methodLabel(p.method, t),
      statusLabel: statusLabel(p.status, t),
      statusKind: p.status,
      amountCents: p.amountCents,
      tipCents: p.tipCents,
      createdAtISO: p.createdAt.toISOString(),
      card: {
        brand: tx.cardBrand,
        last4: tx.cardLast4,
        type: tx.cardType,
        bin: tx.cardBin,
        holder: tx.cardHolderName,
        approvalCode: tx.approvalCode,
        processor: tx.processorName,
        reference: tx.kushkiTxId,
      },
    };
  };

  return (
    <div className="mp-page">
      <header className="mp-page-header">
        <div>
          <p className="mp-eyebrow">{tenant?.name}</p>
          <h1 className="mp-page-title">{t("title")}</h1>
          <p className="mp-page-description">{ux("paymentsDescription")}</p>
        </div>
      </header>
      <form className="mp-payment-filters" role="search">
        <label className="mp-search-field">
          <Icon name="search" />
          <input
            name="q"
            type="search"
            defaultValue={q}
            placeholder={ux("paymentSearch")}
            aria-label={ux("paymentSearch")}
          />
        </label>
        <select
          name="status"
          defaultValue={status}
          aria-label={t("colStatus")}
          className="h-11 px-3 rounded-lg border border-op-border-2 bg-op-surface text-sm"
        >
          <option value="all">{ux("allStatuses")}</option>
          <option value="review">{ux("needsReview")}</option>
          {statuses.map((value) => (
            <option key={value} value={value}>
              {statusLabel(value, t)}
            </option>
          ))}
        </select>
        <button className="mp-btn mp-btn--primary" type="submit">
          {ux("filter")}
        </button>
        {(q || status !== "all") && (
          <Link href="/operator/payments" className="mp-text-link">
            {ux("clearSearch")}
          </Link>
        )}
      </form>
      {/* Desktop: tabla. Las 6 columnas no caben en móvil. */}
      <div className="hidden lg:block bg-op-surface border border-op-border rounded-2xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-op-bg">
            <tr className="text-left">
              <Th>{t("colDate")}</Th>
              <Th>{t("colOrder")}</Th>
              <Th>{counterMode ? t("colChannel") : t("colTable")}</Th>
              <Th>{t("colMethod")}</Th>
              <Th>{t("colCard")}</Th>
              <Th>{t("colStatus")}</Th>
              <Th className="text-right">{t("colAmount")}</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-op-border">
            {payments.map((p) => {
              const detail = buildDetail(p);
              return (
                <tr key={p.id} className="hover:bg-op-bg/60">
                  <Td>
                    {p.createdAt.toLocaleString(locale, {
                      timeZone: "America/Bogota",
                      day: "2-digit",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </Td>
                  <Td>
                    <Link
                      href={`/operator/orders/${p.orderId}`}
                      className="mp-text-link font-mono"
                    >
                      {p.order.shortCode}
                    </Link>
                  </Td>
                  <Td>
                    {counterMode
                      ? t("channelCounter")
                      : t("tableNumber", { number: p.order.table.number })}
                  </Td>
                  <Td>{methodLabel(p.method, t)}</Td>
                  <Td>
                    {detail ? (
                      <PaymentDetailSheet detail={detail} />
                    ) : (
                      <span className="text-op-muted">{"—"}</span>
                    )}
                  </Td>
                  <Td>
                    <span className={statusTint(p.status)}>
                      {statusLabel(p.status, t)}
                    </span>
                    {p.reconciliationRequired && (
                      <Link
                        href={`/operator/orders/${p.orderId}`}
                        className="block text-xs text-danger font-medium mt-1"
                      >
                        {ux("needsReview")}
                      </Link>
                    )}
                  </Td>
                  <Td className="text-right font-mono tabular">
                    {fmtCOP(p.amountCents)}
                  </Td>
                </tr>
              );
            })}
            {payments.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-op-muted text-center">
                  {t("empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Móvil: lista de tarjetas. */}
      <div className="lg:hidden space-y-2">
        {payments.map((p) => {
          const detail = buildDetail(p);
          return (
            <div
              key={p.id}
              className="bg-op-surface border border-op-border rounded-2xl p-4"
            >
              <div className="flex items-center justify-between gap-2">
                <Link
                  href={`/operator/orders/${p.orderId}`}
                  className="mp-text-link font-mono"
                >
                  {p.order.shortCode}
                </Link>
                <span className="font-mono tabular text-base font-semibold">
                  {fmtCOP(p.amountCents)}
                </span>
              </div>
              <div className="mt-1.5 flex items-center justify-between gap-2 text-sm">
                <span className="truncate">{methodLabel(p.method, t)}</span>
                <span className={statusTint(p.status) + " shrink-0"}>
                  {statusLabel(p.status, t)}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-op-muted">
                <span className="truncate">
                  {counterMode
                    ? t("channelCounter")
                    : t("tableNumber", { number: p.order.table.number })}
                </span>
                <span className="shrink-0">
                  {fmtDate(p.createdAt, locale)} ·{" "}
                  {fmtTime(p.createdAt, locale)}
                </span>
              </div>
              {p.reconciliationRequired && (
                <Link
                  href={`/operator/orders/${p.orderId}`}
                  className="block rounded-lg bg-danger/10 px-3 py-2 mt-3 text-sm text-danger font-medium"
                >
                  {ux("needsReview")} →
                </Link>
              )}
              {detail && (
                <div className="mt-2 border-t border-op-border pt-2">
                  <PaymentDetailSheet detail={detail} />
                </div>
              )}
            </div>
          );
        })}
        {payments.length === 0 && (
          <div className="text-center py-10 text-sm text-op-muted">
            {t("empty")}
          </div>
        )}
      </div>
      <nav
        aria-label={ux("pagination")}
        className="mt-5 flex items-center justify-between gap-3"
      >
        <span className="text-sm text-op-muted">
          {ux("pageNumber", { page })}
        </span>
        <div className="flex gap-2">
          {page > 1 && (
            <Link
              href={pageHref(page - 1)}
              className="mp-btn mp-btn--secondary"
            >
              {ux("previous")}
            </Link>
          )}
          {hasNext && (
            <Link
              href={pageHref(page + 1)}
              className="mp-btn mp-btn--secondary"
            >
              {ux("next")}
            </Link>
          )}
        </div>
      </nav>
    </div>
  );
}
function fmtDate(d: Date, locale: string) {
  return new Date(d).toLocaleDateString(locale, {
    timeZone: "America/Bogota",
    day: "2-digit",
    month: "short",
  });
}
function fmtTime(d: Date, locale: string) {
  return new Date(d).toLocaleTimeString(locale, {
    timeZone: "America/Bogota",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function Th({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th className={"px-4 py-3 text-xs font-medium text-op-muted " + className}>
      {children}
    </th>
  );
}
function Td({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={"px-4 py-2.5 " + className}>{children}</td>;
}
function methodLabel(m: string, t: (key: string) => string) {
  const map: Record<string, string> = {
    demo_card: t("mDemoCard"),
    demo_cash: t("mDemoCash"),
    wompi_card: t("mWompiCard"),
    wompi_pse: t("mWompiPse"),
    wompi_nequi: t("mWompiNequi"),
    // Kushki + datáfono externo del comercio. Abreviado para que
    // entre cómodo en la columna sin partir la fila.
    kushki_apple_pay: t("mApplePay"),
    kushki_google_pay: t("mGooglePay"),
    kushki_card: t("mKushkiCard"),
    kushki_card_terminal: t("mKushkiTerminal"),
    external_terminal: t("mExternalTerminal"),
    kushki_pse: t("mKushkiPse"),
  };
  return map[m] ?? m;
}
function statusLabel(s: string, t: (key: string) => string) {
  switch (s) {
    case "approved":
      return t("statusApproved");
    case "declined":
      return t("statusDeclined");
    case "refunded":
      return t("statusRefunded");
    case "failed":
      return t("statusFailed");
    default:
      return t("statusPending");
  }
}
function statusTint(s: string) {
  switch (s) {
    case "approved":
      return "text-ok";
    case "declined":
      return "text-danger";
    case "refunded":
      return "text-op-muted";
    default:
      return "text-[#C98A2E]";
  }
}
