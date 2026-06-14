import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { fmtCOP } from "@/lib/format";
import type { Prisma } from "@prisma/client";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { LiveRefresh } from "../LiveRefresh";

export const dynamic = "force-dynamic";

type StatusFilter = "all" | "open" | "paid" | "cancelled";
type PeriodFilter = "today" | "7d" | "30d" | "all";

const STATUS_OPTS: { id: StatusFilter; labelKey: string }[] = [
  { id: "all", labelKey: "statusAll" },
  { id: "open", labelKey: "statusOpen" },
  { id: "paid", labelKey: "statusPaid" },
  { id: "cancelled", labelKey: "statusCancelled" },
];
const PERIOD_OPTS: { id: PeriodFilter; labelKey: string }[] = [
  { id: "today", labelKey: "periodToday" },
  { id: "7d", labelKey: "period7d" },
  { id: "30d", labelKey: "period30d" },
  { id: "all", labelKey: "periodAll" },
];

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    period?: string;
    q?: string;
  }>;
}) {
  const t = await getTranslations("opOrders");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{t("noRestaurant")}</div>;

  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { slug: true, serviceMode: true },
  });
  const counterMode = tenant?.serviceMode === "counter";

  const sp = await searchParams;
  const status: StatusFilter =
    sp.status === "open" || sp.status === "paid" || sp.status === "cancelled"
      ? sp.status
      : "all";
  const period: PeriodFilter =
    sp.period === "7d" || sp.period === "30d" || sp.period === "all"
      ? sp.period
      : "today";
  const q = sp.q?.trim() ?? "";

  const where: Prisma.OrderWhereInput = { restaurantId };

  if (status === "open") {
    where.status = { in: ["open", "placed", "in_kitchen", "ready", "served", "paying"] };
  } else if (status === "paid") {
    where.status = "paid";
  } else if (status === "cancelled") {
    where.status = "cancelled";
  }

  if (period !== "all") {
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    if (period === "7d") since.setDate(since.getDate() - 6);
    if (period === "30d") since.setDate(since.getDate() - 29);
    where.createdAt = { gte: since };
  }

  if (q) {
    where.shortCode = { contains: q, mode: "insensitive" };
  }

  const orders = await db.order.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      table: true,
      items: { select: { qty: true } },
      payments: { where: { status: "approved" }, select: { amountCents: true } },
    },
  });

  const totals = orders.reduce(
    (acc, o) => {
      acc.count += 1;
      if (o.status === "paid") {
        acc.paidCount += 1;
        acc.paidSum += o.totalCents;
      }
      return acc;
    },
    { count: 0, paidCount: 0, paidSum: 0 },
  );

  // Derivados una sola vez: la tabla (desktop) y las tarjetas (móvil) leen lo
  // mismo.
  const rows = orders.map((o) => ({
    id: o.id,
    shortCode: o.shortCode,
    status: o.status,
    createdAt: o.createdAt,
    items: o.items.reduce((s, i) => s + i.qty, 0),
    subtotalCents: o.subtotalCents,
    paid: o.payments.reduce((s, p) => s + p.amountCents, 0),
    place: counterMode
      ? t("channelCounter")
      : t("tableNumber", { number: o.table.number }),
  }));

  return (
    <div className="p-4 lg:p-6 max-w-6xl mx-auto w-full">
      {tenant?.slug && <LiveRefresh tenantSlug={tenant.slug} />}
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="font-display text-2xl lg:text-3xl">{t("title")}</div>
          <p className="text-sm text-op-muted mt-1">
            {t("summary", {
              count: totals.count,
              paidCount: totals.paidCount,
              amount: fmtCOP(totals.paidSum),
            })}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3 flex-wrap mb-5">
        <FilterGroup
          label={t("filterStatus")}
          options={STATUS_OPTS.map((o) => ({ id: o.id, label: t(o.labelKey) }))}
          current={status}
          paramName="status"
          currentParams={{ period, q }}
        />
        <FilterGroup
          label={t("filterPeriod")}
          options={PERIOD_OPTS.map((o) => ({ id: o.id, label: t(o.labelKey) }))}
          current={period}
          paramName="period"
          currentParams={{ status, q }}
        />
        <form
          className="flex items-center gap-2 w-full sm:w-auto sm:ml-auto"
          action="/operator/orders"
        >
          <input type="hidden" name="status" value={status} />
          <input type="hidden" name="period" value={period} />
          <input
            name="q"
            defaultValue={q}
            placeholder={t("searchPlaceholder")}
            className="h-9 px-3 rounded-full border border-op-border bg-op-surface text-sm flex-1 min-w-0 sm:w-48 sm:flex-none"
          />
          <button
            type="submit"
            className="h-9 px-4 rounded-full bg-ink text-bone text-sm"
          >
            {t("searchButton")}
          </button>
        </form>
      </div>

      {/* Desktop: tabla. La tabla de 8 columnas no cabe en móvil. */}
      <div className="hidden lg:block bg-op-surface border border-op-border rounded-2xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-op-bg">
            <tr className="text-left">
              <Th>{t("colDate")}</Th>
              <Th>{t("colCode")}</Th>
              <Th>{counterMode ? t("colChannel") : t("colTable")}</Th>
              <Th>{t("colStatus")}</Th>
              <Th align="right">{t("colItems")}</Th>
              <Th align="right">{t("colSubtotal")}</Th>
              <Th align="right">{t("colPaid")}</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                className="border-t border-op-border hover:bg-op-bg/40"
              >
                <Td>
                  <div>{fmtDate(r.createdAt)}</div>
                  <div className="text-[10px] text-op-muted">
                    {fmtTime(r.createdAt)}
                  </div>
                </Td>
                <Td className="font-mono">{r.shortCode}</Td>
                <Td>{r.place}</Td>
                <Td>
                  <StatusPill status={r.status} />
                </Td>
                <Td align="right">{r.items}</Td>
                <Td align="right" className="font-mono tabular">
                  {fmtCOP(r.subtotalCents)}
                </Td>
                <Td align="right" className="font-mono tabular">
                  {r.paid === 0 ? "—" : fmtCOP(r.paid)}
                </Td>
                <Td align="right">
                  <Link
                    href={`/operator/orders/${r.id}`}
                    className="text-terracotta hover:underline"
                  >
                    {t("view")} <span aria-hidden>{"→"}</span>
                  </Link>
                </Td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={8}
                  className="text-center py-10 text-sm text-op-muted"
                >
                  {t("empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Móvil: lista de tarjetas. Toda la tarjeta enlaza al detalle. */}
      <div className="lg:hidden space-y-2">
        {rows.map((r) => (
          <Link
            key={r.id}
            href={`/operator/orders/${r.id}`}
            className="block bg-op-surface border border-op-border rounded-2xl p-4 active:bg-op-bg/40"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-sm font-medium">
                {r.shortCode}
              </span>
              <StatusPill status={r.status} />
            </div>
            <div className="mt-1 flex items-center justify-between gap-2 text-sm">
              <span className="truncate">{r.place}</span>
              <span className="text-[11px] text-op-muted shrink-0">
                {fmtDate(r.createdAt)} · {fmtTime(r.createdAt)}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 border-t border-op-border pt-3">
              <CardStat label={t("colItems")} value={String(r.items)} />
              <CardStat
                label={t("colSubtotal")}
                value={fmtCOP(r.subtotalCents)}
              />
              <CardStat
                label={t("colPaid")}
                value={r.paid === 0 ? "—" : fmtCOP(r.paid)}
                align="right"
              />
            </div>
          </Link>
        ))}
        {rows.length === 0 && (
          <div className="text-center py-10 text-sm text-op-muted">
            {t("empty")}
          </div>
        )}
      </div>
    </div>
  );
}

function CardStat({
  label,
  value,
  align,
}: {
  label: string;
  value: string;
  align?: "right";
}) {
  return (
    <div className={align === "right" ? "text-right" : ""}>
      <div className="font-mono text-[9px] tracking-[0.12em] uppercase text-op-muted">
        {label}
      </div>
      <div className="font-mono text-sm tabular mt-0.5">{value}</div>
    </div>
  );
}

function FilterGroup<T extends string>({
  label,
  options,
  current,
  paramName,
  currentParams,
}: {
  label: string;
  options: { id: T; label: string }[];
  current: T;
  paramName: string;
  currentParams: Record<string, string>;
}) {
  return (
    <div>
      <div className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted mb-1">
        {label}
      </div>
      <div className="inline-flex border border-op-border rounded-full bg-op-surface p-0.5">
        {options.map((o) => {
          const qs = new URLSearchParams(currentParams);
          qs.set(paramName, o.id);
          const href = `/operator/orders?${qs.toString()}`;
          const active = current === o.id;
          return (
            <Link
              key={o.id}
              href={href}
              className={
                "px-3 h-7 rounded-full text-xs inline-flex items-center " +
                (active ? "bg-ink text-bone" : "text-op-text/80")
              }
            >
              {o.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function Th({
  children,
  align,
}: {
  children?: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      className={
        "px-4 py-3 font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted " +
        (align === "right" ? "text-right" : "text-left")
      }
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align,
  className,
}: {
  children?: React.ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <td
      className={
        "px-4 py-3 " +
        (align === "right" ? "text-right " : "") +
        (className ?? "")
      }
    >
      {children}
    </td>
  );
}

async function StatusPill({ status }: { status: string }) {
  const t = await getTranslations("opOrders");
  const meta = statusMeta(status, t);
  return (
    <span
      className={
        "px-2 h-5 inline-flex items-center rounded-full text-[10px] font-medium " +
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

function fmtDate(d: Date) {
  return new Date(d).toLocaleDateString("es-CO", {
    day: "2-digit",
    month: "short",
  });
}
function fmtTime(d: Date) {
  return new Date(d).toLocaleTimeString("es-CO", {
    hour: "2-digit",
    minute: "2-digit",
  });
}
