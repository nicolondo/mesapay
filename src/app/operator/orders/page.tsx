import { displayOrderCode } from "@/lib/orderCode";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { fmtCOP, formatDate } from "@/lib/format";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { isModuleEnabled } from "@/lib/modules";
import { bogotaBusinessTodayIso } from "@/lib/bogota";
import { periodIncludes } from "@/lib/erp/reports/period";
import { invoiceDisplayNumber } from "@/lib/dian/invoiceList";
import { LiveRefresh } from "../LiveRefresh";
import { OrderInvoiceMenu } from "./OrderInvoiceMenu";
import { OrdersPeriodNav } from "./OrdersPeriodNav";
import { OrdersSearchForm } from "./OrdersSearchForm";
import { OrdersSourceFilters } from "./OrdersSourceFilters";
import { headers } from "next/headers";
import { appOrigin } from "@/lib/http/publicOrigin";
import { loadManualInvoiceSendInfo } from "@/lib/manualInvoiceSendInfo";
import { ManualInvoiceSendButton } from "@/components/manualInvoice/ManualInvoiceSend";
import type { ManualInvoiceSendInfo } from "@/components/manualInvoice/types";

import type { Locale } from "@/i18n/config";
import { historyDate } from "@/lib/orders/history";
import { loadOrdersList } from "@/lib/orders/ordersListQuery";
import {
  ordersHref,
  ordersPageBounds,
  parseOrdersView,
  type OrdersStatusFilter,
  type OrdersView,
} from "@/lib/orders/ordersView";

export const dynamic = "force-dynamic";

/** Ancla de la lista: la paginación deja la vista al comienzo de la lista. */
const LIST_ID = "ordenes-lista";

const STATUS_OPTS: { id: OrdersStatusFilter; labelKey: string }[] = [
  { id: "all", labelKey: "statusAll" },
  { id: "open", labelKey: "statusOpen" },
  { id: "paid", labelKey: "statusPaid" },
  { id: "cancelled", labelKey: "statusCancelled" },
];

/**
 * Columnas de la fila de escritorio (lg+): fecha · mesa · código · ítems ·
 * estado · total · factura · ⋯. Entre 1024 y 1279 px (con el menú lateral
 * abierto quedan ~730 px) la columna de ítems se esconde.
 */
const ROW_GRID =
  "lg:grid lg:items-center lg:gap-x-2 xl:gap-x-3 " +
  "lg:grid-cols-[8.75rem_minmax(4rem,1fr)_5rem_5.75rem_6.25rem_minmax(5.5rem,1fr)_2rem] " +
  "xl:grid-cols-[9.5rem_minmax(6rem,1fr)_6rem_3rem_6.5rem_7.5rem_minmax(10rem,1.4fr)_2rem]";

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getTranslations("opOrders");
  const locale = (await getLocale()) as Locale;
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{t("noRestaurant")}</div>;

  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { slug: true, serviceMode: true, enabledModules: true, businessDayCutoffHour: true },
  });
  const counterMode = tenant?.serviceMode === "counter";
  // Con facturación electrónica, la factura ACEPTADA por la DIAN también
  // se puede reenviar por correo desde acá (misma ruta que en Facturas), y
  // la fila dice en qué va la factura ante la DIAN.
  const einvoicingOn = isModuleEnabled(tenant?.enabledModules, "einvoicing");

  // Días operativos del comercio (corte configurable, p. ej. 05:00): lo que
  // se vende después de medianoche cuenta para la jornada anterior.
  const cutoff = tenant?.businessDayCutoffHour ?? 0;
  const today = bogotaBusinessTodayIso(cutoff);
  const requested = parseOrdersView(await searchParams, today);

  // Sin tope oculto: una página de 50 y los totales de TODO el período (o
  // de toda la historia si se buscó un número de factura).
  const [list, tables] = await Promise.all([
    loadOrdersList(restaurantId, requested, cutoff),
    db.table.findMany({ where: { restaurantId, kind: "standard" }, select: { id: true, number: true, label: true }, orderBy: { number: "asc" } }),
  ]);
  const view: OrdersView = { ...requested, page: list.page };
  const allDates = list.scope === "all";
  const singleDay = !allDates && view.period.desde === view.period.hasta;
  const { from: shownFrom, to: shownTo } = ordersPageBounds(list.page, list.summary.count);
  const href = (patch: Partial<OrdersView>) => ordersHref(view, today, patch);
  // Lo de hoy se refresca en vivo (SSE); un día pasado ya no cambia.
  const live = allDates || periodIncludes(view.period, today);

  // En la vista de un día basta la hora; en las demás, el día y la hora.
  const fmtWhen = (date: Date) => {
    const time = formatDate(date, { locale, dateStyle: undefined, timeStyle: "short" });
    if (singleDay) return { day: null, time };
    // Bogotá es UTC−5 todo el año: el año de la fecha local, sin Intl.
    const sameYear = String(new Date(date.getTime() - 5 * 3_600_000).getUTCFullYear()) === today.slice(0, 4);
    const day = formatDate(date, {
      locale,
      dateStyle: undefined,
      timeStyle: undefined,
      day: "numeric",
      month: "short",
      ...(sameYear ? {} : { year: "numeric" as const }),
    });
    return { day, time };
  };

  // Facturas manuales abiertas o emitidas por cobrar: la fila ofrece
  // "Emitir y enviar" / "Reenviar link" y dice si sigue por cobrar. Pocas
  // por página (sólo las manuales), una lectura cada una.
  const origin = appOrigin(await headers());
  const sendInfos = new Map<string, ManualInvoiceSendInfo>();
  await Promise.all(
    list.rows
      .filter(
        (o) =>
          o.table.kind === "manual" &&
          ((o.status !== "paid" && o.status !== "cancelled") || !!o.payLink?.creditPaymentId),
      )
      .map(async (o) => {
        const info = await loadManualInvoiceSendInfo({ restaurantId, orderId: o.id, origin });
        if (info) sendInfos.set(o.id, info);
      }),
  );
  const tSend = await getTranslations("manualInvoiceSend");
  const receivableChip = (info: ManualInvoiceSendInfo | undefined) => {
    const r = info?.receivable;
    if (!r || r.totalCents <= 0) return null;
    const paid = r.outstandingCents <= 0;
    return {
      label: paid ? tSend("chipPaidByLink") : r.overdue ? tSend("chipOverdue") : tSend("chipReceivable"),
      tint: paid ? "bg-[#2E6B4C]/15 text-[#1E5339]" : r.overdue ? "bg-terracotta/15 text-terracotta" : "bg-[#C9A227]/15 text-[#7A5E0A]",
    };
  };

  // Derivados una sola vez: la fila (escritorio) y la tarjeta (celular)
  // leen lo mismo.
  const rows = list.rows.map((o) => {
    const invoice = o.simpleInvoice;
    const dianState = einvoicingOn ? invoice?.dianDocument?.state ?? null : null;
    return {
      id: o.id,
      // La orden de la factura buscada va arriba y se marca.
      matched: o.matchedDocument === true,
      code: displayOrderCode(o.shortCode),
      shortCode: o.shortCode,
      status: o.status,
      when: fmtWhen(historyDate(o)),
      items: o.items.reduce((s, i) => s + i.qty, 0),
      // Pagada: lo cobrado (`totalCents`, con impuestos y propina: lo mismo
      // que suma «Ventas brutas»). Si no: la cuenta hasta ahora, neta del
      // descuento del comensal y con el impuesto de las líneas libres.
      totalCents:
        o.status === "paid"
          ? o.totalCents
          : Math.max(0, o.subtotalCents - o.discountCents) + o.taxCents,
      invoice: invoice
        ? {
            id: invoice.id,
            number: invoiceDisplayNumber(o.invoicePrefix, invoice.invoiceNumber),
            dian: dianState,
            dianDocumentId: dianState === "accepted" ? invoice.dianDocument?.id ?? null : null,
          }
        : null,
      place:
        o.table.kind === "manual"
          ? t("manualInvoice")
          : counterMode
            ? t("channelCounter")
            : t("tableNumber", { number: o.table.number }),
      send: sendInfos.get(o.id) ?? null,
      receivable: receivableChip(sendInfos.get(o.id)),
    };
  });

  const filtered = view.status !== "all" || view.q !== "" || view.source !== "all" || view.tableId !== "";
  const tableOptions = tables.map((table) => ({ id: table.id, name: [table.number === 0 && counterMode ? t("channelCounter") : t("tableNumber", { number: table.number }), table.label].filter(Boolean).join(" · ") }));

  return (
    <div className="p-4 lg:p-6 max-w-6xl mx-auto w-full">
      {tenant?.slug && live && <LiveRefresh tenantSlug={tenant.slug} />}

      <header className="mb-4">
        <h1 className="font-display text-2xl lg:text-3xl">{t("title")}</h1>
        {/* Totales de TODO el período filtrado (no de la página). */}
        <dl className="mt-3 grid grid-cols-[1fr_1fr_1.6fr] divide-x divide-op-border rounded-xl border border-op-border bg-op-surface sm:inline-grid sm:grid-cols-[auto_auto_auto]">
          <SummaryStat label={t("statOrders")} value={String(list.summary.count)} />
          <SummaryStat label={t("statPaid")} value={String(list.summary.paidCount)} />
          <SummaryStat
            label={t("statGross")}
            value={fmtCOP(list.summary.paidSum)}
            hint={t("statGrossHint")}
          />
        </dl>
      </header>

      {/* Una sola barra: período, estado y búsqueda. */}
      <section
        aria-label={t("toolbarLabel")}
        className="mb-4 flex flex-col gap-3 rounded-2xl border border-op-border bg-op-surface p-3"
      >
        {allDates ? (
          // Búsqueda por factura (o «todas las fechas»): el período no
          // aplica; se dice y se ofrece volver.
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-op-bg px-3 py-2.5 text-sm">
            <span className="font-medium">
              {view.q ? t("searchScopeAll", { q: view.q }) : t("allDatesTitle")}
            </span>
            <Link
              href={href({ q: "", allDates: false })}
              prefetch={false}
              scroll={false}
              className="text-terracotta hover:underline"
            >
              {view.q ? t("searchClear") : t("allDatesBack")}
            </Link>
          </div>
        ) : (
          <OrdersPeriodNav
            key={`${view.period.desde}:${view.period.hasta}`}
            view={view}
            today={today}
          />
        )}

        <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-center lg:justify-between">
          <div
            className="mp-seg w-full lg:w-auto"
            role="group"
            aria-label={t("filterStatus")}
          >
            {STATUS_OPTS.map((o) => {
              const active = view.status === o.id;
              return (
                <Link
                  key={o.id}
                  href={href({ status: o.id })}
                  prefetch={false}
                  scroll={false}
                  aria-current={active ? "true" : undefined}
                  data-active={active ? "true" : undefined}
                  className="mp-seg__i !h-auto min-h-[44px] min-w-0 flex-1 basis-0 flex-col !gap-0 !px-1.5 !py-1 justify-center lg:!h-9 lg:min-h-0 lg:flex-none lg:basis-auto lg:flex-row lg:!gap-1.5 lg:!px-3.5"
                >
                  <span className="truncate text-xs lg:text-[13px]">{t(o.labelKey)}</span>
                  <span className="font-mono text-[11px] tabular text-op-muted">
                    {list.counts[o.id]}
                  </span>
                </Link>
              );
            })}
          </div>
          <OrdersSearchForm view={view} today={today} />
        </div>

        <OrdersSourceFilters view={view} today={today} tables={tableOptions} />

        {view.q && !allDates && (
          // Búsqueda por código dentro del período: un clic la amplía.
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-op-muted">
            <span>{t("searchScopePeriod", { q: view.q })}</span>
            <Link
              href={href({ allDates: true })}
              prefetch={false}
              scroll={false}
              className="text-terracotta hover:underline"
            >
              {t("searchAllDates")}
            </Link>
            <Link
              href={href({ q: "" })}
              prefetch={false}
              scroll={false}
              className="text-terracotta hover:underline"
            >
              {t("searchClear")}
            </Link>
          </p>
        )}
      </section>

      <section id={LIST_ID} aria-label={t("title")} className="scroll-mt-4">
        {rows.length === 0 ? (
          <EmptyState
            title={
              view.q
                ? t("emptySearch", { q: view.q })
                : filtered
                  ? t("empty")
                  : singleDay && view.period.desde === today
                    ? t("emptyToday")
                    : t("emptyPeriod")
            }
            actions={[
              ...(view.q && !allDates ? [{ href: href({ allDates: true }), label: t("searchAllDates") }] : []),
              ...(view.status !== "all" ? [{ href: href({ status: "all" }), label: t("showAll") }] : []),
              ...(view.source !== "all" || view.tableId ? [{ href: href({ source: "all", tableId: "" }), label: t("sourceClear") }] : []),
              ...(!filtered && !allDates && !periodIncludes(view.period, today)
                ? [{ href: href({ period: { desde: today, hasta: today } }), label: t("backToToday") }]
                : []),
            ]}
          />
        ) : (
          <ul className="flex flex-col gap-2 lg:gap-0 lg:rounded-2xl lg:border lg:border-op-border lg:bg-op-surface">
            {/* Encabezado de columnas (sólo escritorio). */}
            <li
              aria-hidden
              className={
                "hidden px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-op-muted lg:rounded-t-2xl lg:bg-op-bg " +
                ROW_GRID
              }
            >
              <span>{t("colDate")}</span>
              <span>{counterMode ? t("colChannel") : t("colTable")}</span>
              <span>{t("colCode")}</span>
              <span className="hidden text-right xl:block">{t("colItems")}</span>
              <span>{t("colStatus")}</span>
              <span className="text-right">{t("colTotal")}</span>
              <span>{t("colInvoice")}</span>
              <span />
            </li>
            {rows.map((r) => {
              // El enlace cubre toda la fila/tarjeta: tocarla abre la orden.
              // El menú de la factura queda por encima (z-10).
              const open = (
                <Link
                  href={`/operator/orders/${r.id}`}
                  prefetch={false}
                  title={r.shortCode}
                  aria-label={t("openOrder", { code: r.code })}
                  className="font-mono after:absolute after:inset-0 after:rounded-2xl focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-terracotta lg:after:rounded-none"
                >
                  {r.code}
                </Link>
              );
              const menu = r.invoice && (
                <OrderInvoiceMenu
                  orderId={r.id}
                  invoiceId={r.invoice.id}
                  dianDocumentId={r.invoice.dianDocumentId}
                  number={r.invoice.number}
                />
              );
              const when = (
                <>
                  {r.when.day && <span>{r.when.day}{" · "}</span>}
                  <span className="tabular">{r.when.time}</span>
                </>
              );
              return (
                <li
                  key={r.id}
                  className={
                    "relative rounded-2xl border bg-op-surface transition-colors hover:bg-op-bg/60 lg:rounded-none lg:border-0 lg:border-t lg:border-op-border lg:last:rounded-b-2xl " +
                    (r.matched ? "border-terracotta/40 lg:bg-terracotta/5" : "border-op-border lg:bg-transparent")
                  }
                >
                  {/* Escritorio: una línea, en columnas. */}
                  <div className={"hidden min-h-12 px-4 py-1.5 text-sm " + ROW_GRID}>
                    <span className="truncate text-[13px] text-op-muted">{when}</span>
                    <span className="truncate">{r.place}</span>
                    <span>{open}</span>
                    <span className="hidden text-right tabular xl:block">{r.items}</span>
                    <span>
                      {r.receivable ? <ReceivablePill {...r.receivable} /> : <StatusPill status={r.status} />}
                    </span>
                    <span className="text-right font-mono tabular">{fmtCOP(r.totalCents)}</span>
                    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                      {r.invoice ? (
                        <InvoiceChip number={r.invoice.number} dian={r.invoice.dian} />
                      ) : (
                        <span className="text-op-muted">{"—"}</span>
                      )}
                      {r.send && <ManualInvoiceSendButton info={r.send} />}
                    </span>
                    <span className="flex justify-end">{menu}</span>
                  </div>

                  {/* Celular: tarjeta de 2 líneas (3 con factura). */}
                  <div className="px-4 py-3 lg:hidden">
                    <div className="flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate text-sm font-medium">{r.place}</span>
                      <span className="shrink-0 font-mono text-sm font-medium tabular">
                        {fmtCOP(r.totalCents)}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate text-[12px] text-op-muted">
                        <span className="text-sm text-op-text">{open}</span>
                        {" · "}
                        {when}
                        {" · "}
                        {t("itemsCount", { count: r.items })}
                      </span>
                      <span className="shrink-0">
                        {r.receivable ? <ReceivablePill {...r.receivable} /> : <StatusPill status={r.status} />}
                      </span>
                    </div>
                    {r.invoice && (
                      <div className="mt-2 flex items-center justify-between gap-3">
                        <InvoiceChip number={r.invoice.number} dian={r.invoice.dian} />
                        {menu}
                      </div>
                    )}
                    {r.send && (
                      <div className="mt-2 flex justify-end">
                        <ManualInvoiceSendButton info={r.send} />
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {list.summary.count > 0 && (
        <nav
          aria-label={t("pagination")}
          className="mt-4 flex flex-wrap items-center justify-between gap-3"
        >
          <span className="text-sm text-op-muted tabular">
            {t("pageShowing", { from: shownFrom, to: shownTo, total: list.summary.count })}
          </span>
          {list.pageCount > 1 && (
            <div className="flex items-center gap-2">
              <PageLink href={list.page > 1 ? `${href({ page: list.page - 1 })}#${LIST_ID}` : null}>
                {t("pagePrev")}
              </PageLink>
              <span className="px-1 text-xs text-op-muted tabular">
                {t("pageOf", { page: list.page, pages: list.pageCount })}
              </span>
              <PageLink href={list.page < list.pageCount ? `${href({ page: list.page + 1 })}#${LIST_ID}` : null}>
                {t("pageNext")}
              </PageLink>
            </div>
          )}
        </nav>
      )}
    </div>
  );
}

function SummaryStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 px-3 py-2.5 sm:px-5">
      <dt className="truncate font-mono text-[9px] uppercase tracking-[0.14em] text-op-muted">
        {label}
      </dt>
      <dd className="mt-0.5 truncate font-mono text-base font-medium tabular sm:text-lg">{value}</dd>
      {hint && <dd className="truncate text-[10px] text-op-muted">{hint}</dd>}
    </div>
  );
}

/** «Anterior» / «Siguiente»; sin destino, apagado (no es un enlace). */
function PageLink({ href, children }: { href: string | null; children: React.ReactNode }) {
  const cls = "mp-btn mp-btn--secondary mp-btn--sm";
  return href ? (
    <Link href={href} prefetch={false} className={cls}>
      {children}
    </Link>
  ) : (
    <span aria-disabled="true" className={`${cls} pointer-events-none opacity-40`}>
      {children}
    </span>
  );
}

function EmptyState({
  title,
  actions,
}: {
  title: string;
  actions: { href: string; label: string }[];
}) {
  return (
    <div className="rounded-2xl border border-dashed border-op-border bg-op-surface px-6 py-12 text-center">
      <svg
        className="mx-auto mb-3 text-op-muted"
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M6 3h9l3 3v15H6z" />
        <path d="M9 9h6M9 13h6M9 17h3" />
      </svg>
      <p className="text-sm text-op-muted">{title}</p>
      {actions.length > 0 && (
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {actions.map((a) => (
            <Link
              key={a.href}
              href={a.href}
              prefetch={false}
              scroll={false}
              className="mp-btn mp-btn--secondary mp-btn--sm"
            >
              {a.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Número de la factura de la cuenta y, con facturación electrónica, en qué
 * va ante la DIAN (punto de color + texto: el color solo no basta).
 */
async function InvoiceChip({ number, dian }: { number: string; dian: string | null }) {
  const t = await getTranslations("opOrders");
  const state =
    dian === "accepted"
      ? { label: t("dianAccepted"), dot: "bg-[#2E6B4C]" }
      : dian === "rejected"
        ? { label: t("dianRejected"), dot: "bg-danger" }
        : dian
          ? { label: t("dianPending"), dot: "bg-[#C98A2E]" }
          : null;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 truncate rounded-md border border-op-border bg-op-bg px-2 py-0.5 text-[11px]">
      <span className="font-mono">{number}</span>
      {state && (
        <>
          <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${state.dot}`} />
          <span className="truncate text-op-muted">{state.label}</span>
        </>
      )}
    </span>
  );
}

/** Factura manual emitida por cobrar: por cobrar / vencida / cobrada (en vez de "Pagada"). */
function ReceivablePill({ label, tint }: { label: string; tint: string }) {
  return (
    <span className={"px-2 h-5 inline-flex items-center rounded-full text-[10px] font-medium whitespace-nowrap " + tint}>
      {label}
    </span>
  );
}

async function StatusPill({ status }: { status: string }) {
  const t = await getTranslations("opOrders");
  const meta = statusMeta(status, t);
  return (
    <span
      className={
        "px-2 h-5 inline-flex items-center rounded-full text-[10px] font-medium whitespace-nowrap " +
        meta.tint
      }
    >
      {meta.label}
    </span>
  );
}

function statusMeta(s: string, t: (key: string) => string) {
  switch (s) {
    case "open":
      return { label: t("pillOpen"), tint: "bg-paper text-op-muted" };
    case "placed":
      return { label: t("pillPlaced"), tint: "bg-[#C98A2E]/20 text-[#8F6828]" };
    case "in_kitchen":
      return { label: t("pillInKitchen"), tint: "bg-[#C98A2E]/20 text-[#8F6828]" };
    case "ready":
      return { label: t("pillReady"), tint: "bg-[#2E6B4C]/15 text-[#1E5339]" };
    case "served":
      return { label: t("pillServed"), tint: "bg-[#2E6B4C]/15 text-[#1E5339]" };
    case "paying":
      return { label: t("pillPaying"), tint: "bg-ink/10 text-ink" };
    case "paid":
      return { label: t("pillPaid"), tint: "bg-[#2E6B4C]/15 text-[#1E5339]" };
    case "cancelled":
      return { label: t("pillCancelled"), tint: "bg-danger/15 text-danger" };
    default:
      return { label: s, tint: "bg-paper text-op-muted" };
  }
}
