import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { fmtBogotaDateTime } from "@/lib/bogota";
import {
  STATUS_LABEL,
  deriveMembershipStatus,
  type MembershipStatus,
} from "@/lib/membership";

function bogotaDate(d: Date): string {
  return fmtBogotaDateTime(d).date;
}

export const dynamic = "force-dynamic";

export default async function RestaurantsAdmin({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string }>;
}) {
  const sp = await searchParams;
  const t = await getTranslations("opAdmin");
  const [restaurants, paidCounts, lastOrders, firstOrders, operatorCounts] =
    await Promise.all([
      db.restaurant.findMany({
        orderBy: { createdAt: "desc" },
        include: {
          _count: {
            select: { tables: true, menuItems: true, orders: true },
          },
        },
      }),
      db.order.groupBy({
        by: ["restaurantId"],
        where: { status: "paid" },
        _count: { _all: true },
      }),
      db.order.groupBy({
        by: ["restaurantId"],
        _max: { createdAt: true },
      }),
      db.order.groupBy({
        by: ["restaurantId"],
        _min: { createdAt: true },
      }),
      db.user.groupBy({
        by: ["restaurantId"],
        where: { role: "operator" },
        _count: { _all: true },
      }),
    ]);

  const paidByRest = new Map(
    paidCounts.map((p) => [p.restaurantId, p._count._all]),
  );
  const lastByRest = new Map(
    lastOrders.map((l) => [l.restaurantId, l._max.createdAt]),
  );
  const firstByRest = new Map(
    firstOrders.map((l) => [l.restaurantId, l._min.createdAt]),
  );
  const opsByRest = new Map(
    operatorCounts.map((o) => [o.restaurantId, o._count._all]),
  );

  return (
    <div className="flex-1 p-4 md:p-6 max-w-7xl mx-auto w-full">
      <div className="flex items-baseline justify-between gap-3 mb-6 flex-wrap">
        <div className="min-w-0">
          <div className="font-display text-2xl md:text-3xl">{t("restaurantsTitle")}</div>
          <div className="text-sm text-op-muted mt-1">
            {t("accountsInPlatform", { count: restaurants.length })}
          </div>
        </div>
        <Link
          href="/admin/restaurants/new"
          className="h-10 px-4 rounded-full bg-ink text-bone text-sm font-medium inline-flex items-center shrink-0"
        >
          {t("newRestaurant")}
        </Link>
      </div>

      {sp.ok && (
        <div className="mb-4 rounded-lg border border-ok/30 bg-ok/10 text-[#1E5339] px-3 py-2 text-sm">
          {t.rich("restaurantCreated", {
            slug: sp.ok,
            code: (chunks) => <span className="font-mono">{chunks}</span>,
          })}
        </div>
      )}

      {restaurants.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-op-border bg-op-surface p-10 text-center">
          <div className="font-display text-2xl mb-1">{t("noAccountsTitle")}</div>
          <div className="text-sm text-op-muted mb-4">
            {t("noAccountsBody")}
          </div>
          <Link
            href="/admin/restaurants/new"
            className="h-10 px-4 rounded-xl bg-ink text-bone text-sm font-medium inline-flex items-center"
          >
            {t("newRestaurant")}
          </Link>
        </div>
      ) : (
        <>
        {/* Mobile: card list — much friendlier than horizontal-scrolling
            a 10-column table. Shows the same data the operator needs
            to triage at a glance (name, plan/status pills, key counts). */}
        <ul className="md:hidden space-y-3">
          {restaurants.map((r) => {
            const paid = paidByRest.get(r.id) ?? 0;
            const last = lastByRest.get(r.id) ?? null;
            const ops = opsByRest.get(r.id) ?? 0;
            const state = deriveState({
              orders: r._count.orders,
              paid,
              lastOrderAt: last,
              operators: ops,
            });
            const membership = deriveMembershipStatus({
              plan: r.plan,
              periodEndsAt: r.periodEndsAt,
              suspended: r.suspended,
            });
            return (
              <li key={r.id}>
                <Link
                  href={`/admin/restaurants/${r.id}`}
                  className="block rounded-2xl border border-op-border bg-op-surface p-4 active:scale-[0.99] transition-transform"
                >
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div className="min-w-0">
                      <div className="font-display text-lg leading-tight truncate">
                        {r.name}
                      </div>
                      <div className="font-mono text-[11px] text-op-muted">
                        /{r.slug}
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <MembershipPill status={membership} plan={r.plan} t={t} />
                      <StatePill state={state} t={t} />
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <MiniStat label={t("colOperators")} value={ops} />
                    <MiniStat label={t("colMenu")} value={r._count.menuItems} />
                    <MiniStat label={t("colTables")} value={r._count.tables} />
                    <MiniStat label={t("colOrders")} value={r._count.orders} />
                    <MiniStat label={t("colPaid")} value={paid} />
                    <MiniStat
                      label={t("colLast")}
                      value={last ? <RelTime date={last} t={t} /> : "—"}
                    />
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>

        {/* Desktop: full table view. Hidden on mobile because horizontal
            scroll on a 10-column table is borderline unusable on a phone. */}
        <div className="hidden md:block rounded-2xl border border-op-border bg-op-surface overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-op-bg">
              <tr className="text-left">
                <Th>{t("colRestaurant")}</Th>
                <Th>{t("colCreated")}</Th>
                <Th>{t("colOperators")}</Th>
                <Th>{t("colMenu")}</Th>
                <Th>{t("colTables")}</Th>
                <Th>{t("colOrders")}</Th>
                <Th>{t("colPaid")}</Th>
                <Th>{t("colLast")}</Th>
                <Th>{t("colPlan")}</Th>
                <Th>{t("colStatus")}</Th>
              </tr>
            </thead>
            <tbody>
              {restaurants.map((r) => {
                const paid = paidByRest.get(r.id) ?? 0;
                const last = lastByRest.get(r.id) ?? null;
                const first = firstByRest.get(r.id) ?? null;
                const ops = opsByRest.get(r.id) ?? 0;
                const state = deriveState({
                  orders: r._count.orders,
                  paid,
                  lastOrderAt: last,
                  operators: ops,
                });
                const membership = deriveMembershipStatus({
                  plan: r.plan,
                  periodEndsAt: r.periodEndsAt,
                  suspended: r.suspended,
                });
                return (
                  <tr
                    key={r.id}
                    className="border-t border-op-border hover:bg-op-bg"
                  >
                    <Td>
                      <Link
                        href={`/admin/restaurants/${r.id}`}
                        className="block"
                      >
                        <div className="font-medium hover:underline">
                          {r.name}
                        </div>
                        <div className="font-mono text-[11px] text-op-muted">
                          {r.slug}
                        </div>
                      </Link>
                    </Td>
                    <Td>
                      <div>{bogotaDate(r.createdAt)}</div>
                      {first && (
                        <div className="font-mono text-[10px] text-op-muted">
                          {t("firstOrder", { date: bogotaDate(first) })}
                        </div>
                      )}
                    </Td>
                    <Td>{ops}</Td>
                    <Td>{r._count.menuItems}</Td>
                    <Td>{r._count.tables}</Td>
                    <Td>{r._count.orders}</Td>
                    <Td>{paid}</Td>
                    <Td>
                      {last ? (
                        <RelTime date={last} t={t} />
                      ) : (
                        <span className="text-op-muted">—</span>
                      )}
                    </Td>
                    <Td>
                      <MembershipPill status={membership} plan={r.plan} t={t} />
                    </Td>
                    <Td>
                      <StatePill state={state} t={t} />
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        </>
      )}
    </div>
  );
}

function MiniStat({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-op-border px-2 py-1.5">
      <div className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted">
        {label}
      </div>
      <div className="text-sm mt-0.5 truncate">{value}</div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-3 py-2 font-mono text-[10px] tracking-wider uppercase text-op-muted font-normal">
      {children}
    </th>
  );
}
function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-3 py-3 align-top">{children}</td>;
}

type State = "activo" | "en_uso" | "configurando" | "inactivo" | "nuevo";

function deriveState({
  orders,
  paid,
  lastOrderAt,
  operators,
}: {
  orders: number;
  paid: number;
  lastOrderAt: Date | null;
  operators: number;
}): State {
  if (operators === 0) return "nuevo";
  if (orders === 0) return "configurando";
  const daysSinceLast = lastOrderAt
    ? (Date.now() - lastOrderAt.getTime()) / 86400000
    : Infinity;
  if (daysSinceLast > 30) return "inactivo";
  if (paid > 0) return "activo";
  return "en_uso";
}

type Translate = Awaited<ReturnType<typeof getTranslations<"opAdmin">>>;

function StatePill({ state, t }: { state: State; t: Translate }) {
  const map: Record<State, { label: string; cls: string }> = {
    activo: {
      label: t("stateActivo"),
      cls: "bg-[#2E6B4C]/12 text-[#1E5339] border-[#2E6B4C]/35",
    },
    en_uso: {
      label: t("stateEnUso"),
      cls: "bg-[#C98A2E]/15 text-[#7F5A1F] border-[#C98A2E]/50",
    },
    configurando: {
      label: t("stateConfigurando"),
      cls: "bg-terracotta/10 text-terracotta border-terracotta/30",
    },
    inactivo: {
      label: t("stateInactivo"),
      cls: "bg-danger/10 text-danger border-danger/25",
    },
    nuevo: {
      label: t("stateNuevo"),
      cls: "bg-op-bg text-op-muted border-op-border",
    },
  };
  const { label, cls } = map[state];
  return (
    <span
      className={
        "font-mono text-[10px] tracking-wider uppercase px-2 py-1 rounded border " +
        cls
      }
    >
      {label}
    </span>
  );
}

function MembershipPill({
  status,
  plan,
  t,
}: {
  status: MembershipStatus;
  plan: "trial" | "basic" | "pro";
  t: Translate;
}) {
  const planLabel: Record<"trial" | "basic" | "pro", string> = {
    trial: t("planTrial"),
    basic: t("planBasic"),
    pro: t("planPro"),
  };
  const map: Record<MembershipStatus, string> = {
    al_dia: "bg-ok/10 text-[#1E5339] border-ok/30",
    trial: "bg-op-bg text-op-muted border-op-border",
    por_vencer: "bg-[#C98A2E]/15 text-[#7F5A1F] border-[#C98A2E]/50",
    vencido: "bg-danger/10 text-danger border-danger/25",
    suspendido: "bg-ink/80 text-bone border-ink",
  };
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[11px]">{planLabel[plan]}</span>
      <span
        className={
          "font-mono text-[9px] tracking-wider uppercase px-2 py-0.5 rounded border inline-block w-fit " +
          map[status]
        }
      >
        {STATUS_LABEL[status]}
      </span>
    </div>
  );
}

function RelTime({ date, t }: { date: Date; t: Translate }) {
  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  const label =
    days === 0
      ? t("relToday")
      : days === 1
        ? t("relYesterday")
        : days < 7
          ? t("relDaysAgo", { days })
          : days < 30
            ? t("relWeeksAgo", { weeks: Math.floor(days / 7) })
            : bogotaDate(date);
  return <span className="font-mono text-xs text-op-muted">{label}</span>;
}
