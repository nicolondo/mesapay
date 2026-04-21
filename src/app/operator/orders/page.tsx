import Link from "next/link";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { fmtCOP } from "@/lib/format";
import type { Prisma } from "@prisma/client";
import { LiveRefresh } from "../LiveRefresh";

export const dynamic = "force-dynamic";

type StatusFilter = "all" | "open" | "paid" | "cancelled";
type PeriodFilter = "today" | "7d" | "30d" | "all";

const STATUS_OPTS: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "Todas" },
  { id: "open", label: "Abiertas" },
  { id: "paid", label: "Pagadas" },
  { id: "cancelled", label: "Canceladas" },
];
const PERIOD_OPTS: { id: PeriodFilter; label: string }[] = [
  { id: "today", label: "Hoy" },
  { id: "7d", label: "7 días" },
  { id: "30d", label: "30 días" },
  { id: "all", label: "Todo" },
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
  const session = await auth();
  const restaurantId = session!.user!.restaurantId;
  if (!restaurantId) return <div className="p-6">Sin restaurante.</div>;

  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { slug: true },
  });

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

  return (
    <div className="p-6 max-w-6xl mx-auto w-full">
      {tenant?.slug && <LiveRefresh tenantSlug={tenant.slug} />}
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="font-display text-3xl">Órdenes</div>
          <p className="text-sm text-op-muted mt-1">
            {totals.count} {totals.count === 1 ? "orden" : "órdenes"} ·{" "}
            {totals.paidCount} pagada{totals.paidCount === 1 ? "" : "s"} ·{" "}
            {fmtCOP(totals.paidSum)}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3 flex-wrap mb-5">
        <FilterGroup
          label="Estado"
          options={STATUS_OPTS}
          current={status}
          paramName="status"
          currentParams={{ period, q }}
        />
        <FilterGroup
          label="Periodo"
          options={PERIOD_OPTS}
          current={period}
          paramName="period"
          currentParams={{ status, q }}
        />
        <form className="ml-auto flex items-center gap-2" action="/operator/orders">
          <input type="hidden" name="status" value={status} />
          <input type="hidden" name="period" value={period} />
          <input
            name="q"
            defaultValue={q}
            placeholder="Buscar por código"
            className="h-9 px-3 rounded-full border border-op-border bg-op-surface text-sm w-48"
          />
          <button
            type="submit"
            className="h-9 px-4 rounded-full bg-ink text-bone text-sm"
          >
            Buscar
          </button>
        </form>
      </div>

      <div className="bg-op-surface border border-op-border rounded-2xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-op-bg">
            <tr className="text-left">
              <Th>Fecha</Th>
              <Th>Código</Th>
              <Th>Mesa</Th>
              <Th>Estado</Th>
              <Th align="right">Items</Th>
              <Th align="right">Subtotal</Th>
              <Th align="right">Pagado</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => {
              const paid = o.payments.reduce((s, p) => s + p.amountCents, 0);
              const items = o.items.reduce((s, i) => s + i.qty, 0);
              return (
                <tr
                  key={o.id}
                  className="border-t border-op-border hover:bg-op-bg/40"
                >
                  <Td>
                    <div>{fmtDate(o.createdAt)}</div>
                    <div className="text-[10px] text-op-muted">
                      {fmtTime(o.createdAt)}
                    </div>
                  </Td>
                  <Td className="font-mono">{o.shortCode}</Td>
                  <Td>Mesa {o.table.number}</Td>
                  <Td>
                    <StatusPill status={o.status} />
                  </Td>
                  <Td align="right">{items}</Td>
                  <Td align="right" className="font-mono tabular">
                    {fmtCOP(o.subtotalCents)}
                  </Td>
                  <Td align="right" className="font-mono tabular">
                    {paid === 0 ? "—" : fmtCOP(paid)}
                  </Td>
                  <Td align="right">
                    <Link
                      href={`/operator/orders/${o.id}`}
                      className="text-terracotta hover:underline"
                    >
                      Ver →
                    </Link>
                  </Td>
                </tr>
              );
            })}
            {orders.length === 0 && (
              <tr>
                <td
                  colSpan={8}
                  className="text-center py-10 text-sm text-op-muted"
                >
                  No hay órdenes con estos filtros.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
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

function StatusPill({ status }: { status: string }) {
  const meta = statusMeta(status);
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

function statusMeta(s: string) {
  switch (s) {
    case "open":
      return { label: "Abierto", tint: "bg-paper text-op-muted" };
    case "placed":
      return { label: "Enviado", tint: "bg-[#C98A2E]/20 text-[#8F6828]" };
    case "in_kitchen":
      return { label: "En cocina", tint: "bg-[#C98A2E]/20 text-[#8F6828]" };
    case "ready":
      return { label: "Listo", tint: "bg-[#2E6B4C]/15 text-[#1E5339]" };
    case "served":
      return { label: "Servido", tint: "bg-[#2E6B4C]/15 text-[#1E5339]" };
    case "paying":
      return { label: "Cobrando", tint: "bg-ink/10 text-ink" };
    case "paid":
      return { label: "Pagado", tint: "bg-[#2E6B4C]/15 text-[#1E5339]" };
    case "cancelled":
      return { label: "Cancelada", tint: "bg-danger/15 text-danger" };
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
