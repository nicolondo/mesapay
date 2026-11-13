import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Icon, type IconName } from "@/components/ui/Icon";
import { db } from "@/lib/db";
import { fmtCOP } from "@/lib/format";
import { fmtBogotaDateTime } from "@/lib/bogota";
import {
  deriveMembershipStatus,
  type MembershipStatus,
} from "@/lib/membership";
import { getPlanCatalog } from "@/lib/planCatalog";
import { listAuditEvents } from "@/lib/auditLog";

export const dynamic = "force-dynamic";

/**
 * Resumen de plataforma. Las cifras mantienen su fuente y definición;
 * el directorio de restaurantes sigue siendo la entrada de /admin.
 */
export default async function AdminDashboard() {
  const t = await getTranslations("opAdmin");
  const ui = await getTranslations("adminWorkspacePage");
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
    <div className="mp-page">
      <header className="mp-page-header flex-wrap">
        <div className="min-w-0 max-w-2xl">
          <p className="mp-eyebrow">{ui("overviewEyebrow")}</p>
          <h1 className="mp-page-title">{t("dashTitle")}</h1>
          <p className="mp-page-description">{t("dashIntro")}</p>
        </div>
        <Link href="/admin/restaurants" prefetch={false} className="mp-btn mp-btn--primary">
          {ui("quickRestaurants")} <Icon name="arrow" />
        </Link>
      </header>

      {/* KPIs principales */}
      <section aria-labelledby="admin-subscriptions-title" className="mb-8">
      <h2 id="admin-subscriptions-title" className="mb-4 text-base font-semibold tracking-tight">{ui("subscriptionsSection")}</h2>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-op-border bg-op-border xl:grid-cols-4">
        <KpiCard
          label={t("kpiMrr")}
          value={fmtCOP(mrrCents)}
          hint={t("kpiMrrHint")}
          primary
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
      </section>

      {/* Volumen transaccional */}
      <section aria-labelledby="admin-merchant-activity-title" className="mb-8">
      <h2 id="admin-merchant-activity-title" className="mb-4 text-base font-semibold tracking-tight">{ui("merchantActivitySection")}</h2>
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1.15fr_1fr]">
        <div className="overflow-hidden rounded-2xl border border-op-border">
        <KpiCard
          label={t("kpiTransactions")}
          value={fmtCOP(salesNow)}
          hint={t("kpiTransactionsHint", {
            count: salesThisMonth._count._all,
            delta: formatDelta(salesNow, salesPrev),
          })}
          big
        />
        </div>
        <div className="rounded-2xl border border-op-border bg-op-surface p-5">
          <h3 className="mb-4 text-sm font-semibold">
            {t("byStatus")}
          </h3>
          <ul className="space-y-3 text-sm">
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
                <span className="flex-1 ml-2">{t("ms_" + s)}</span>
                <span className="tabular font-semibold">
                  {statusCount[s]}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      </section>

      {/* Por plan */}
      <div className="mb-8 grid grid-cols-1 gap-5 xl:grid-cols-2">
        <section className="rounded-2xl border border-op-border bg-op-surface p-5" aria-labelledby="admin-plan-title">
          <div className="flex items-center justify-between mb-3">
            <h2 id="admin-plan-title" className="text-base font-semibold tracking-tight">
              {t("byPlan")}
            </h2>
            <Link
              href="/admin/plans"
              prefetch={false}
              className="mp-text-link"
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
                  className="flex flex-wrap items-center justify-between gap-3 py-4 text-sm"
                >
                  <div className="min-w-0">
                    <div className="font-medium">{p.name}</div>
                    <div className="mt-1 text-xs leading-relaxed text-op-muted">
                      {p.tier} <span aria-hidden>{"·"}</span>{" "}
                      {t("priceSuggested", { price: fmtCOP(p.defaultPriceCents) })}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="tabular font-semibold">{b.count}</div>
                    <div className="mt-1 text-xs text-op-muted">
                      {t("mrrSuffix", { value: fmtCOP(b.mrr) })}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="rounded-2xl border border-op-border bg-op-surface p-5" aria-labelledby="admin-top-title">
          <h2 id="admin-top-title" className="mb-3 text-base font-semibold tracking-tight">
            {t("topMerchants")}
          </h2>
          {topRestaurants.length === 0 ? (
            <div className="text-sm text-op-muted">
              {t("noTransactionsMonth")}
            </div>
          ) : (
            <ol className="divide-y divide-op-border">
              {topRestaurants.map((r, i) => (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-4 text-sm"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="w-5 shrink-0 text-xs tabular text-op-muted" aria-hidden>
                      {i + 1}
                    </span>
                    <Link
                      href={`/admin/restaurants/${r.id}`}
                      prefetch={false}
                      className="break-words font-medium hover:text-terracotta"
                    >
                      {r.name}
                    </Link>
                  </div>
                  <div className="shrink-0 text-sm font-semibold tabular">
                    {fmtCOP(r.volumeCents)}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      {/* Necesitan atención + actividad reciente */}
      <div className="mb-8 grid grid-cols-1 gap-5 xl:grid-cols-2">
        <section className="rounded-2xl border border-op-border bg-op-surface p-5" aria-labelledby="admin-attention-title">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h2 id="admin-attention-title" className="text-base font-semibold tracking-tight">
              {t("needsAttention")}
            </h2>
            <span className="rounded-lg bg-op-bg px-2.5 py-1 text-sm font-semibold tabular text-op-muted">
              {needsAttention.length}
            </span>
          </div>
          <p className="mb-4 text-xs leading-relaxed text-op-muted">{ui("attentionIntro")}</p>
          {needsAttention.length === 0 ? (
            <div className="text-sm text-op-muted">
              {t("allUpToDate")}
            </div>
          ) : (
            <ul className="divide-y divide-op-border">
              {needsAttention.map((r) => (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-4"
                >
                  <Link
                    href={`/admin/restaurants/${r.id}`}
                    prefetch={false}
                    className="min-w-0 flex-1 hover:text-terracotta"
                  >
                    <div className="break-words text-sm font-medium">{r.name}</div>
                    <div className="mt-1 text-xs leading-relaxed text-op-muted">
                      {planLabelOf(r.plan)} <span aria-hidden>{"·"}</span>{" "}
                      {r.daysLeft != null && r.daysLeft >= 0
                        ? t("expiresInDays", { days: r.daysLeft })
                        : r.daysLeft != null
                          ? t("expiredDaysAgo", { days: Math.abs(r.daysLeft) })
                          : t("noPeriod")}
                    </div>
                  </Link>
                  <StatusPillSmall status={r.status} label={t("ms_" + r.status)} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-2xl border border-op-border bg-op-surface p-5" aria-labelledby="admin-recent-activity-title">
          <div className="flex items-center justify-between mb-3">
            <h2 id="admin-recent-activity-title" className="text-base font-semibold tracking-tight">
              {t("recentActivity")}
            </h2>
            <Link
              href="/admin/audit"
              prefetch={false}
              className="mp-text-link"
            >
              {t("viewAll")}
            </Link>
          </div>
          {recentEvents.length === 0 ? (
            <div className="text-sm text-op-muted">
              {t("noRecentActivity")}
            </div>
          ) : (
            <ul className="divide-y divide-op-border">
              {recentEvents.map((e) => {
                const { date, time } = fmtBogotaDateTime(e.occurredAt);
                return (
                  <li key={e.id} className="py-3 text-sm">
                    <div className="break-words leading-relaxed">{e.summary}</div>
                    <div className="mt-1 break-words text-xs leading-relaxed text-op-muted">
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
        </section>
      </div>

      {/* Últimos comercios creados */}
      <section className="rounded-2xl border border-op-border bg-op-surface p-5" aria-labelledby="admin-latest-merchants-title">
        <div className="flex items-center justify-between mb-3">
          <h2 id="admin-latest-merchants-title" className="text-base font-semibold tracking-tight">
            {t("latestMerchants")}
          </h2>
          <Link
            href="/admin/restaurants"
            prefetch={false}
            className="mp-text-link"
          >
            {t("viewAllPlural")}
          </Link>
        </div>
        {recentRestaurants.length === 0 && <p className="py-4 text-sm leading-relaxed text-op-muted">{ui("noRecentRestaurants")}</p>}
        <ul className="divide-y divide-op-border">
          {recentRestaurants.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-3 py-4 text-sm"
            >
              <Link
                href={`/admin/restaurants/${r.id}`}
                prefetch={false}
                className="min-w-0 flex-1 hover:text-terracotta"
              >
                <div className="break-words font-medium">{r.name}</div>
                <div className="mt-1 break-words text-xs leading-relaxed text-op-muted">
                  /{r.slug} <span aria-hidden>{"·"}</span>{" "}
                  {t("createdOn", { date: fmtBogotaDateTime(r.createdAt).date })}
                </div>
              </Link>
              <div className="text-right shrink-0">
                <div className="text-sm font-medium">{planLabelOf(r.plan)}</div>
                <div className="mt-1 text-xs tabular text-op-muted">
                  {r.monthlyPriceCents > 0
                    ? fmtCOP(r.monthlyPriceCents)
                    : "—"}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <nav aria-labelledby="admin-quick-access-title" className="mt-8">
        <h2 id="admin-quick-access-title" className="mb-4 text-base font-semibold tracking-tight">{ui("quickAccess")}</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <QuickAccess href="/admin/restaurants" icon="store" title={ui("quickRestaurants")} description={ui("quickRestaurantsBody")} />
          <QuickAccess href="/admin/wallet" icon="wallet" title={ui("quickWallet")} description={ui("quickWalletBody")} />
          <QuickAccess href="/admin/plans" icon="orders" title={ui("quickPlans")} description={ui("quickPlansBody")} />
          <QuickAccess href="/admin/audit" icon="audit" title={ui("quickAudit")} description={ui("quickAuditBody")} />
        </div>
      </nav>
    </div>
  );
}

function KpiCard({
  label,
  value,
  hint,
  big,
  primary,
}: {
  label: string;
  value: string;
  hint?: string;
  big?: boolean;
  primary?: boolean;
}) {
  return (
    <div className={`h-full min-w-0 p-4 sm:p-5 ${primary ? "bg-ink text-bone" : "bg-op-surface"}`}>
      <div className={`text-xs font-medium ${primary ? "text-bone/75" : "text-op-muted"}`}>
        {label}
      </div>
      <div
        className={
          "mt-4 break-words font-semibold tabular leading-tight tracking-tight " +
          (big ? "text-3xl sm:text-4xl" : "text-xl sm:text-2xl")
        }
      >
        {value}
      </div>
      {hint && (
        <p className={`mt-3 text-xs leading-relaxed ${primary ? "text-bone/75" : "text-op-muted"}`}>{hint}</p>
      )}
    </div>
  );
}

function QuickAccess({ href, icon, title, description }: { href: string; icon: IconName; title: string; description: string }) {
  return (
    <Link href={href} prefetch={false} className="group flex min-w-0 items-start gap-3 rounded-xl border border-op-border bg-op-surface p-4 transition-colors hover:border-terracotta/40 hover:bg-op-bg">
      <Icon name={icon} className="mt-0.5 shrink-0 text-terracotta" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold leading-snug">{title}</span>
        <span className="mt-1.5 block text-xs leading-relaxed text-op-muted">{description}</span>
      </span>
      <Icon name="arrow" className="mt-0.5 h-4 w-4 shrink-0 text-op-muted transition-transform group-hover:translate-x-0.5" />
    </Link>
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

function StatusPillSmall({
  status,
  label,
}: {
  status: MembershipStatus;
  label: string;
}) {
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
        "text-xs font-medium px-2 py-1 rounded border shrink-0 " +
        map[status]
      }
    >
      {label}
    </span>
  );
}

function formatDelta(now: number, prev: number): string {
  if (prev === 0) return now > 0 ? "+∞" : "±0";
  const pct = ((now - prev) / prev) * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(0)}%`;
}
