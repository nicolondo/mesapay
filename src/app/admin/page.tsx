import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { fmtCOP } from "@/lib/format";
import { fmtBogotaDateTime } from "@/lib/bogota";
import {
  deriveMembershipStatus,
  STATUS_LABEL,
  type MembershipStatus,
} from "@/lib/membership";
import { getPlanCatalog } from "@/lib/planCatalog";
import { listAuditEvents } from "@/lib/auditLog";

export const dynamic = "force-dynamic";

/**
 * /admin landing — dashboard de plataforma con KPIs. Reemplaza el
 * antiguo redirect a /admin/restaurants. Si necesitas la lista
 * cruda, el link queda igual en la nav.
 *
 * Las queries son agresivas pero todas indexed (groupBy + count).
 * En producción con N comercios chicos cabe en < 200ms.
 */
export default async function AdminDashboard() {
  const t = await getTranslations("opAdmin");
  const now = new Date();
  const startOfMonth = new Date(
    now.getFullYear(),
    now.getMonth(),
    1,
    0,
    0,
    0,
    0,
  );
  const startOfPrevMonth = new Date(
    now.getFullYear(),
    now.getMonth() - 1,
    1,
    0,
    0,
    0,
    0,
  );

  const [
    restaurants,
    planCatalog,
    membershipPaymentsThisMonth,
    membershipPaymentsPrevMonth,
    salesThisMonth,
    salesPrevMonth,
    newRestaurantsThisMonth,
    recentRestaurants,
    recentEvents,
  ] = await Promise.all([
    // Todos los comercios para calcular MRR + status en JS — son
    // pocos (decenas), así que evitamos múltiples groupBy.
    db.restaurant.findMany({
      select: {
        id: true,
        name: true,
        slug: true,
        plan: true,
        monthlyPriceCents: true,
        periodEndsAt: true,
        suspended: true,
        createdAt: true,
      },
    }),
    getPlanCatalog(),
    db.membershipPayment.aggregate({
      where: { createdAt: { gte: startOfMonth } },
      _sum: { amountCents: true },
      _count: { _all: true },
    }),
    db.membershipPayment.aggregate({
      where: {
        createdAt: { gte: startOfPrevMonth, lt: startOfMonth },
      },
      _sum: { amountCents: true },
      _count: { _all: true },
    }),
    // Volumen transaccional de los comercios (Payments aprobados).
    db.payment.aggregate({
      where: {
        status: "approved",
        settledAt: { gte: startOfMonth },
      },
      _sum: { amountCents: true },
      _count: { _all: true },
    }),
    db.payment.aggregate({
      where: {
        status: "approved",
        settledAt: { gte: startOfPrevMonth, lt: startOfMonth },
      },
      _sum: { amountCents: true },
    }),
    db.restaurant.count({
      where: { createdAt: { gte: startOfMonth } },
    }),
    db.restaurant.findMany({
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
        id: true,
        name: true,
        slug: true,
        plan: true,
        monthlyPriceCents: true,
        createdAt: true,
      },
    }),
    listAuditEvents({ limit: 8 }),
  ]);

  // Status de cada comercio + agrupación.
  type StatusCount = Record<MembershipStatus, number>;
  const statusCount: StatusCount = {
    trial: 0,
    al_dia: 0,
    por_vencer: 0,
    vencido: 0,
    suspendido: 0,
  };
  let mrrCents = 0; // suma monthlyPriceCents de comercios al_dia o por_vencer (no trial, no vencido, no suspendido)
  const byPlan: Record<string, { count: number; mrr: number }> = {};
  for (const r of restaurants) {
    const status = deriveMembershipStatus({
      plan: r.plan,
      periodEndsAt: r.periodEndsAt,
      suspended: r.suspended,
      now,
    });
    statusCount[status] += 1;
    if (status === "al_dia" || status === "por_vencer") {
      mrrCents += r.monthlyPriceCents;
    }
    if (!byPlan[r.plan]) byPlan[r.plan] = { count: 0, mrr: 0 };
    byPlan[r.plan].count += 1;
    if (status === "al_dia" || status === "por_vencer") {
      byPlan[r.plan].mrr += r.monthlyPriceCents;
    }
  }

  // Top 5 comercios por volumen transaccional del mes.
  const topByVolume = await db.payment.groupBy({
    by: ["orderId"],
    where: {
      status: "approved",
      settledAt: { gte: startOfMonth },
    },
    _sum: { amountCents: true },
  });
  // El groupBy es por orderId pero queremos por restaurante —
  // necesitamos las ordenes para mapear. Hacemos una segunda query
  // con los orderIds top + sumamos en JS.
  const orderIds = topByVolume.map((g) => g.orderId);
  const orders = orderIds.length
    ? await db.order.findMany({
        where: { id: { in: orderIds } },
        select: { id: true, restaurantId: true },
      })
    : [];
  const orderToRest = new Map(orders.map((o) => [o.id, o.restaurantId]));
  const restVolume = new Map<string, number>();
  for (const g of topByVolume) {
    const restId = orderToRest.get(g.orderId);
    if (!restId) continue;
    const current = restVolume.get(restId) ?? 0;
    restVolume.set(restId, current + (g._sum.amountCents ?? 0));
  }
  const topRestaurants = Array.from(restVolume.entries())
    .map(([restId, total]) => {
      const r = restaurants.find((x) => x.id === restId);
      return r
        ? { id: r.id, name: r.name, slug: r.slug, volumeCents: total }
        : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.volumeCents - a.volumeCents)
    .slice(0, 5);

  // Comercios por vencer pronto (≤7 días) o vencidos — para call to
  // action. Si la cron de recordatorios está corriendo esto debería
  // tender a cero, pero igual lo surfaceamos.
  const needsAttention = restaurants
    .map((r) => ({
      ...r,
      status: deriveMembershipStatus({
        plan: r.plan,
        periodEndsAt: r.periodEndsAt,
        suspended: r.suspended,
        now,
      }),
      daysLeft:
        r.periodEndsAt &&
        Math.floor((r.periodEndsAt.getTime() - now.getTime()) / 86400000),
    }))
    .filter(
      (r) =>
        r.status === "por_vencer" ||
        r.status === "vencido" ||
        r.status === "suspendido",
    )
    .sort((a, b) => {
      // Vencidos primero, luego por_vencer por daysLeft ascendente.
      const order: Record<MembershipStatus, number> = {
        suspendido: 0,
        vencido: 1,
        por_vencer: 2,
        trial: 3,
        al_dia: 4,
      };
      return order[a.status] - order[b.status];
    })
    .slice(0, 6);

  const planLabelOf = (tier: string) =>
    planCatalog.find((p) => p.tier === tier)?.name ?? tier;

  const mrrPrev = membershipPaymentsPrevMonth._sum.amountCents ?? 0;
  const mrrNow = membershipPaymentsThisMonth._sum.amountCents ?? 0;
  const salesNow = salesThisMonth._sum.amountCents ?? 0;
  const salesPrev = salesPrevMonth._sum.amountCents ?? 0;

  return (
    <div className="flex-1 p-4 md:p-6 max-w-6xl mx-auto w-full">
      <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
        {t("platformLabel")}
      </div>
      <div className="font-display text-3xl tracking-[-0.015em] mb-1">
        {t("dashTitle")}
      </div>
      <p className="text-sm text-op-muted mb-6">
        {t("dashIntro")}
      </p>

      {/* KPIs principales */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <KpiCard
          label={t("kpiMrr")}
          value={fmtCOP(mrrCents)}
          hint={t("kpiMrrHint")}
        />
        <KpiCard
          label={t("kpiActive")}
          value={String(restaurants.length - statusCount.suspendido)}
          hint={t("kpiActiveHint", {
            total: restaurants.length,
            suspended: statusCount.suspendido,
          })}
        />
        <KpiCard
          label={t("kpiBilled")}
          value={fmtCOP(mrrNow)}
          hint={t("kpiBilledHint", {
            count: membershipPaymentsThisMonth._count._all,
            delta: formatDelta(mrrNow, mrrPrev),
          })}
        />
        <KpiCard
          label={t("kpiNew")}
          value={String(newRestaurantsThisMonth)}
          hint={t("kpiNewHint")}
        />
      </div>

      {/* Volumen transaccional */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
        <KpiCard
          label={t("kpiTransactions")}
          value={fmtCOP(salesNow)}
          hint={t("kpiTransactionsHint", {
            count: salesThisMonth._count._all,
            delta: formatDelta(salesNow, salesPrev),
          })}
          big
        />
        <div className="rounded-2xl border border-op-border bg-op-surface p-5">
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-3">
            {t("byStatus")}
          </div>
          <ul className="space-y-1.5 text-sm">
            {(
              [
                "al_dia",
                "por_vencer",
                "vencido",
                "trial",
                "suspendido",
              ] as MembershipStatus[]
            ).map((s) => (
              <li
                key={s}
                className="flex items-center justify-between"
              >
                <StatusDot status={s} />
                <span className="flex-1 ml-2">{STATUS_LABEL[s]}</span>
                <span className="font-mono tabular text-op-muted">
                  {statusCount[s]}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Por plan */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
        <div className="rounded-2xl border border-op-border bg-op-surface p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
              {t("byPlan")}
            </div>
            <Link
              href="/admin/plans"
              className="font-mono text-[10px] tracking-wider uppercase text-terracotta hover:underline"
            >
              {t("edit")}
            </Link>
          </div>
          <ul className="divide-y divide-op-border">
            {planCatalog.map((p) => {
              const b = byPlan[p.tier] ?? { count: 0, mrr: 0 };
              return (
                <li
                  key={p.tier}
                  className="py-2.5 flex items-center justify-between text-sm"
                >
                  <div>
                    <div>{p.name}</div>
                    <div className="font-mono text-[10px] text-op-muted">
                      {p.tier} <span aria-hidden>{"·"}</span>{" "}
                      {t("priceSuggested", { price: fmtCOP(p.defaultPriceCents) })}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono tabular">{b.count}</div>
                    <div className="font-mono text-[10px] text-op-muted">
                      {t("mrrSuffix", { value: fmtCOP(b.mrr) })}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="rounded-2xl border border-op-border bg-op-surface p-5">
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-3">
            {t("topMerchants")}
          </div>
          {topRestaurants.length === 0 ? (
            <div className="text-sm text-op-muted">
              {t("noTransactionsMonth")}
            </div>
          ) : (
            <ul className="divide-y divide-op-border">
              {topRestaurants.map((r, i) => (
                <li
                  key={r.id}
                  className="py-2.5 flex items-center justify-between text-sm"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="font-mono text-[10px] text-op-muted w-4">
                      {i + 1}
                    </span>
                    <Link
                      href={`/admin/restaurants/${r.id}`}
                      className="truncate hover:text-terracotta"
                    >
                      {r.name}
                    </Link>
                  </div>
                  <div className="font-mono tabular text-sm">
                    {fmtCOP(r.volumeCents)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Necesitan atención + actividad reciente */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
        <div className="rounded-2xl border border-op-border bg-op-surface p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
              {t("needsAttention")}
            </div>
            <span className="font-mono text-[10px] text-op-muted">
              {needsAttention.length}
            </span>
          </div>
          {needsAttention.length === 0 ? (
            <div className="text-sm text-op-muted">
              {t("allUpToDate")}
            </div>
          ) : (
            <ul className="divide-y divide-op-border">
              {needsAttention.map((r) => (
                <li
                  key={r.id}
                  className="py-2.5 flex items-center justify-between gap-3"
                >
                  <Link
                    href={`/admin/restaurants/${r.id}`}
                    className="min-w-0 flex-1 hover:text-terracotta"
                  >
                    <div className="text-sm truncate">{r.name}</div>
                    <div className="font-mono text-[10px] text-op-muted">
                      {planLabelOf(r.plan)} <span aria-hidden>{"·"}</span>{" "}
                      {r.daysLeft != null && r.daysLeft >= 0
                        ? t("expiresInDays", { days: r.daysLeft })
                        : r.daysLeft != null
                          ? t("expiredDaysAgo", { days: Math.abs(r.daysLeft) })
                          : t("noPeriod")}
                    </div>
                  </Link>
                  <StatusPillSmall status={r.status} />
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-2xl border border-op-border bg-op-surface p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
              {t("recentActivity")}
            </div>
            <Link
              href="/admin/audit"
              className="font-mono text-[10px] tracking-wider uppercase text-terracotta hover:underline"
            >
              {t("viewAll")}
            </Link>
          </div>
          {recentEvents.length === 0 ? (
            <div className="text-sm text-op-muted">
              {t("noRecentActivity")}
            </div>
          ) : (
            <ul className="space-y-2.5">
              {recentEvents.map((e) => {
                const { date, time } = fmtBogotaDateTime(e.occurredAt);
                return (
                  <li key={e.id} className="text-sm">
                    <div className="truncate">{e.summary}</div>
                    <div className="font-mono text-[10px] text-op-muted">
                      {date} {time} <span aria-hidden>{"·"}</span> {e.actorEmail}
                      {e.restaurant && (
                        <>
                          {" "}
                          <span aria-hidden>{"·"}</span> {e.restaurant.name}
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {/* Últimos comercios creados */}
      <div className="rounded-2xl border border-op-border bg-op-surface p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
            {t("latestMerchants")}
          </div>
          <Link
            href="/admin/restaurants"
            className="font-mono text-[10px] tracking-wider uppercase text-terracotta hover:underline"
          >
            {t("viewAllPlural")}
          </Link>
        </div>
        <ul className="divide-y divide-op-border">
          {recentRestaurants.map((r) => (
            <li
              key={r.id}
              className="py-2.5 flex items-center justify-between text-sm"
            >
              <Link
                href={`/admin/restaurants/${r.id}`}
                className="min-w-0 flex-1 hover:text-terracotta"
              >
                <div className="truncate">{r.name}</div>
                <div className="font-mono text-[10px] text-op-muted">
                  /{r.slug} <span aria-hidden>{"·"}</span>{" "}
                  {t("createdOn", { date: fmtBogotaDateTime(r.createdAt).date })}
                </div>
              </Link>
              <div className="text-right shrink-0">
                <div className="text-sm">{planLabelOf(r.plan)}</div>
                <div className="font-mono text-[10px] text-op-muted">
                  {r.monthlyPriceCents > 0
                    ? fmtCOP(r.monthlyPriceCents)
                    : "—"}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function KpiCard({
  label,
  value,
  hint,
  big,
}: {
  label: string;
  value: string;
  hint?: string;
  big?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-op-border bg-op-surface p-5">
      <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
        {label}
      </div>
      <div
        className={
          "font-display tabular mt-1 " + (big ? "text-3xl" : "text-2xl")
        }
      >
        {value}
      </div>
      {hint && (
        <div className="font-mono text-[10px] text-op-muted mt-1">{hint}</div>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: MembershipStatus }) {
  const colors: Record<MembershipStatus, string> = {
    al_dia: "bg-ok",
    por_vencer: "bg-[#C98A2E]",
    vencido: "bg-danger",
    trial: "bg-op-muted",
    suspendido: "bg-ink",
  };
  return (
    <span
      aria-hidden
      className={"inline-block w-2 h-2 rounded-full shrink-0 " + colors[status]}
    />
  );
}

function StatusPillSmall({ status }: { status: MembershipStatus }) {
  const map: Record<MembershipStatus, string> = {
    al_dia: "bg-ok/10 text-[#1E5339] border-ok/30",
    trial: "bg-op-bg text-op-muted border-op-border",
    por_vencer: "bg-[#C98A2E]/15 text-[#7F5A1F] border-[#C98A2E]/50",
    vencido: "bg-danger/10 text-danger border-danger/25",
    suspendido: "bg-ink/80 text-bone border-ink",
  };
  return (
    <span
      className={
        "font-mono text-[10px] tracking-wider uppercase px-2 py-0.5 rounded border shrink-0 " +
        map[status]
      }
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

function formatDelta(now: number, prev: number): string {
  if (prev === 0) return now > 0 ? "+∞" : "±0";
  const pct = ((now - prev) / prev) * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(0)}%`;
}
