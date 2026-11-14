import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { requestTime } from "@/lib/requestTime";
import { auth } from "@/auth";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { syncOrderSubtotalFromLiveItems } from "@/lib/orderTotals";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { appOrigin } from "@/lib/http/publicOrigin";
import { formatDate, formatMoney } from "@/lib/format";
import { displayOrderCode } from "@/lib/orderCode";
import { isChargeBlockedForRole } from "@/lib/chargeControl";
import { canMoveBetweenTables } from "@/lib/tableMoveControl";
import { canCompOrders, resolveCompAllowedRoles, type CompPolicyView } from "@/lib/staffPolicies";
import { asSalesTaxKind } from "@/lib/checkoutTax";
import { OPEN_ORDER_STATUS_FILTER } from "@/lib/manualInvoice";
import { buildManualInvoiceSendInfo } from "@/lib/manualInvoiceSendInfo";
import { loadReceivableCharge } from "@/lib/manualInvoiceReceivable";
import { formatInvoiceNumber, type InvoiceSnapshot } from "@/lib/invoice";
import type { Locale } from "@/i18n/config";
import { LiveRefresh } from "../LiveRefresh";
import { ACTIVE_ORDER_INCLUDE, loadActiveOrderContext, summarizeActiveOrder } from "../tables/activeOrders";
import { ManualInvoicesBoard, type ManualInvoiceTileData } from "./ManualInvoicesBoard";

export const dynamic = "force-dynamic";

/**
 * /operator/facturas-manuales — la casa de las FACTURAS MANUALES.
 *
 * El dueño: «no quiero que las facturas manuales queden en la pantalla de
 * Mesas hasta que quede pagada». Una factura manual nunca se dibuja en
 * Mesas, el Salón, «Mesas en vivo» del datáfono ni los contadores de
 * cuentas abiertas. Vive acá:
 *
 *   · Pendientes: las que se están armando (borrador) o se enviaron sólo
 *     con el link, con su ficha de siempre para seguir editándolas.
 *     `?open=<tableId>` abre la ficha al cargar (la recién creada desde
 *     Mesas, Nueva orden o el menú en modo operador).
 *   · Por cobrar: las emitidas y enviadas que el cliente todavía debe (su
 *     ficha está en Órdenes; la deuda, en Cartera).
 *
 * El historial completo (cobradas, descartadas) está en Órdenes, filtro
 * «Facturas manuales».
 */
export default async function ManualInvoicesPage({
  searchParams,
}: {
  searchParams?: Promise<{ open?: string }>;
}) {
  const t = await getTranslations("manualInvoices");
  const tSend = await getTranslations("manualInvoiceSend");
  const locale = (await getLocale()) as Locale;
  const sp = (await searchParams) ?? {};
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{t("noRestaurant")}</div>;
  const tenant = await db.restaurant.findUnique({ where: { id: restaurantId } });
  if (!tenant) return <div className="p-6">{t("noRestaurant")}</div>;

  const session = await auth();
  const role = session?.user?.role ?? null;
  const chargeLocked = isChargeBlockedForRole(role, tenant.adminOnlyCharge ?? false);
  const moveLocked = !canMoveBetweenTables(role, tenant.adminOnlyTableMove);
  const compPolicy: CompPolicyView = {
    locked: !canCompOrders(role, tenant.compAllowedRoles),
    allowedRoles: resolveCompAllowedRoles(tenant.compAllowedRoles),
  };

  // Pendientes: mesas ocultas `kind = manual` con su cuenta viva.
  const openIds = await db.order.findMany({
    where: { restaurantId, table: { kind: "manual" }, ...OPEN_ORDER_STATUS_FILTER },
    select: { id: true },
  });
  await Promise.all(openIds.map((o) => syncOrderSubtotalFromLiveItems(o.id)));
  const manualTables = await db.table.findMany({
    where: { restaurantId, kind: "manual", orders: { some: OPEN_ORDER_STATUS_FILTER } },
    orderBy: { number: "desc" },
    include: {
      orders: {
        where: OPEN_ORDER_STATUS_FILTER,
        orderBy: { createdAt: "desc" },
        take: 1,
        include: ACTIVE_ORDER_INCLUDE,
      },
    },
  });
  const ctx = await loadActiveOrderContext(manualTables.flatMap((tb) => tb.orders));
  const origin = appOrigin(await headers());
  const currency = await getCurrencyForCountry(tenant.country);
  const tiles: ManualInvoiceTileData[] = manualTables
    .filter((tb) => tb.orders.length > 0)
    .map((tb) => {
      const order = tb.orders[0];
      return {
        id: tb.id,
        number: tb.number,
        qrToken: tb.qrToken,
        order: summarizeActiveOrder(order, ctx).activeOrder,
        sendInfo: buildManualInvoiceSendInfo({
          order: { ...order, approvedPayments: order.payments.filter((p) => p.status === "approved") },
          tenant,
          currency,
          origin,
          link: order.payLink,
          invoiceNumber: ctx.invoiceViews.get(order.id)?.documentNumber ?? null,
          customerEmail: order.invoiceRequests[0]?.email ?? null,
          customerName: order.invoiceRequests[0]?.customerName ?? null,
        }),
      };
    })
    // Las más nuevas primero.
    .sort((a, b) => (a.order.id < b.order.id ? 1 : -1));

  // Por cobrar: emitidas y enviadas con su link, con saldo.
  const receivableLinks = await db.paymentLink.findMany({
    where: { restaurantId, kind: "order", creditPaymentId: { not: null }, status: "pending" },
    select: {
      creditPaymentId: true,
      order: {
        select: {
          id: true,
          shortCode: true,
          simpleInvoice: { select: { invoiceNumber: true, snapshot: true } },
          invoiceRequests: { orderBy: { createdAt: "desc" }, take: 1, select: { customerName: true } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });
  const nowMs = await requestTime();
  const receivables = (
    await Promise.all(
      receivableLinks.map(async (l) => {
        if (!l.creditPaymentId || !l.order) return null;
        const charge = await loadReceivableCharge(restaurantId, l.creditPaymentId);
        if (!charge || charge.outstandingCents <= 0 || charge.totalCents <= 0) return null;
        return {
          orderId: l.order.id,
          code: displayOrderCode(l.order.shortCode),
          number: l.order.simpleInvoice
            ? formatInvoiceNumber(l.order.simpleInvoice.snapshot as unknown as InvoiceSnapshot, l.order.simpleInvoice.invoiceNumber)
            : null,
          customer: l.order.invoiceRequests[0]?.customerName ?? null,
          outstandingCents: charge.outstandingCents,
          dueDate: charge.dueDate,
          overdue: charge.dueDate.getTime() < nowMs,
        };
      }),
    )
  ).filter((r): r is NonNullable<typeof r> => r !== null);

  const money = (cents: number) => formatMoney(cents, { currency, locale });
  const day = (date: Date) => formatDate(date, { locale, dateStyle: "medium", timeStyle: undefined });

  return (
    <div className="mp-page">
      <LiveRefresh tenantSlug={tenant.slug} />
      <div className="mb-5">
        <p className="mp-eyebrow">{tenant.name}</p>
        <h1 className="mp-page-title">{t("title")}</h1>
        <p className="mp-page-description">{t("description")}</p>
      </div>

      <ManualInvoicesBoard
        tiles={tiles}
        initialOpenTileId={sp.open ?? null}
        tenantSlug={tenant.slug}
        country={tenant.country}
        salesTax={{ kind: asSalesTaxKind(tenant.salesTaxKind), pct: tenant.salesTaxPct }}
        chargeLocked={chargeLocked}
        moveLocked={moveLocked}
        compPolicy={compPolicy}
        viewerRole={role}
      />

      <section aria-label={t("receivableTitle")} className="mt-8">
        <h2 className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">{t("receivableTitle")}</h2>
        <p className="text-[11px] text-op-muted mt-0.5 mb-3">{t("receivableHint")}</p>
        {receivables.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-op-border bg-op-surface p-4 text-center text-sm text-op-muted">
            {t("receivableEmpty")}
          </p>
        ) : (
          <ul className="divide-y divide-op-border rounded-2xl border border-op-border bg-op-surface">
            {receivables.map((r) => (
              <li key={r.orderId}>
                <Link
                  href={`/operator/orders/${encodeURIComponent(r.orderId)}`}
                  prefetch={false}
                  className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 hover:bg-op-bg/60"
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-medium truncate">
                      {r.number ? t("receivableInvoice", { number: r.number }) : r.code}
                      {r.customer && <span className="text-op-muted font-normal">{` · ${r.customer}`}</span>}
                    </span>
                    <span className={"block text-xs " + (r.overdue ? "text-terracotta" : "text-op-muted")}>
                      {r.overdue ? t("receivableOverdue", { date: day(r.dueDate) }) : t("receivableDue", { date: day(r.dueDate) })}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span
                      className={
                        "px-2 h-5 inline-flex items-center rounded-full text-[10px] font-medium " +
                        (r.overdue ? "bg-terracotta/15 text-terracotta" : "bg-[#C9A227]/15 text-[#7A5E0A]")
                      }
                    >
                      {r.overdue ? tSend("chipOverdue") : tSend("chipReceivable")}
                    </span>
                    <span className="font-mono text-sm tabular">{money(r.outstandingCents)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="mt-6 text-xs text-op-muted">
        {t("historyHint")}{" "}
        <Link href="/operator/orders?source=manual&fechas=todas" prefetch={false} className="underline hover:text-op-text">
          {t("historyLink")}
        </Link>
      </p>
    </div>
  );
}
