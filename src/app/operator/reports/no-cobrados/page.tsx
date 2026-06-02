import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { fmtCOP } from "@/lib/format";
import { fmtBogotaDateTime } from "@/lib/bogota";

export const dynamic = "force-dynamic";

/**
 * Reporte de items NO COBRADOS — agrega cancelaciones + comps de
 * OrderItem en un rango de fechas, con filtros para que el admin
 * detecte patrones:
 *   - ¿Qué platos se cancelan/no cobran más? (señal cocina)
 *   - ¿Qué mesero acumula más? (señal capacitación o sospecha)
 *   - ¿Cuál es el motivo más frecuente? (señal proceso)
 *
 * Filtros via query string para que cada vista quede bookmarkable:
 *   ?range=today|7d|30d|month  (default 7d)
 *   ?kind=cancel|comp          (default ambos)
 *   ?email=<actorEmail>        (mesero específico)
 *
 * Sin paginación por ahora — limitamos a 500 filas; si un comercio
 * cruza ese volumen en su rango más amplio (30d), agregamos cursor.
 */

type RangeKey = "today" | "7d" | "30d" | "month";

const RANGE_LABEL_KEY: Record<RangeKey, string> = {
  today: "rangeToday",
  "7d": "range7d",
  "30d": "range30d",
  month: "rangeMonth",
};

function startOfRange(range: RangeKey, now = new Date()): Date {
  const today = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    0,
    0,
    0,
    0,
  );
  if (range === "today") return today;
  if (range === "7d") {
    const d = new Date(today);
    d.setDate(d.getDate() - 7);
    return d;
  }
  if (range === "30d") {
    const d = new Date(today);
    d.setDate(d.getDate() - 30);
    return d;
  }
  // month
  return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
}

export default async function NoCobradosPage({
  searchParams,
}: {
  searchParams: Promise<{
    range?: string;
    kind?: string;
    email?: string;
  }>;
}) {
  const t = await getTranslations("opReports");
  const rangeLabel = (r: RangeKey) => t(RANGE_LABEL_KEY[r]);
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{t("noRestaurant")}</div>;

  const sp = await searchParams;
  const range: RangeKey =
    sp.range === "today" || sp.range === "30d" || sp.range === "month"
      ? sp.range
      : "7d";
  const kindFilter =
    sp.kind === "cancel" || sp.kind === "comp" ? sp.kind : undefined;
  const emailFilter = sp.email?.trim() || undefined;

  const since = startOfRange(range);

  const items = await db.orderItem.findMany({
    where: {
      cancelledAt: { gte: since, not: null },
      order: { restaurantId },
      ...(kindFilter === "cancel"
        ? {
            // Back-compat: filas viejas sin cancellationKind se
            // tratan como "cancel" — incluimos null cuando filtran
            // por cancel.
            OR: [{ cancellationKind: "cancel" }, { cancellationKind: null }],
          }
        : {}),
      ...(kindFilter === "comp" ? { cancellationKind: "comp" } : {}),
      ...(emailFilter ? { cancelledByEmail: emailFilter } : {}),
    },
    include: {
      order: {
        select: {
          id: true,
          shortCode: true,
          table: { select: { number: true, label: true } },
        },
      },
    },
    orderBy: { cancelledAt: "desc" },
    take: 500,
  });

  // Agrego en JS — 500 filas cabe holgado.
  let totalLostCents = 0;
  let cancelCount = 0;
  let compCount = 0;
  let cancelLostCents = 0;
  let compLostCents = 0;
  const byEmail = new Map<string, { count: number; lostCents: number }>();
  const byReason = new Map<string, { count: number; lostCents: number }>();
  const byDish = new Map<string, { count: number; lostCents: number }>();
  for (const it of items) {
    const cost = it.priceCentsSnapshot * it.qty;
    totalLostCents += cost;
    const kind = (it.cancellationKind ?? "cancel") as "cancel" | "comp";
    if (kind === "comp") {
      compCount += 1;
      compLostCents += cost;
    } else {
      cancelCount += 1;
      cancelLostCents += cost;
    }
    const email = it.cancelledByEmail ?? t("noEmail");
    const e = byEmail.get(email) ?? { count: 0, lostCents: 0 };
    e.count += 1;
    e.lostCents += cost;
    byEmail.set(email, e);
    const reason = it.cancellationReason?.trim() || t("noReason");
    const r = byReason.get(reason) ?? { count: 0, lostCents: 0 };
    r.count += 1;
    r.lostCents += cost;
    byReason.set(reason, r);
    const d = byDish.get(it.nameSnapshot) ?? { count: 0, lostCents: 0 };
    d.count += 1;
    d.lostCents += cost;
    byDish.set(it.nameSnapshot, d);
  }
  const topEmails = Array.from(byEmail.entries())
    .map(([email, v]) => ({ email, ...v }))
    .sort((a, b) => b.lostCents - a.lostCents)
    .slice(0, 6);
  const topReasons = Array.from(byReason.entries())
    .map(([reason, v]) => ({ reason, ...v }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);
  const topDishes = Array.from(byDish.entries())
    .map(([dish, v]) => ({ dish, ...v }))
    .sort((a, b) => b.lostCents - a.lostCents)
    .slice(0, 6);

  const buildHref = (patch: Partial<{ range: string; kind?: string; email?: string }>) => {
    const next = new URLSearchParams();
    next.set("range", patch.range ?? range);
    const k = patch.kind === undefined ? kindFilter : patch.kind || undefined;
    if (k) next.set("kind", k);
    const e = patch.email === undefined ? emailFilter : patch.email || undefined;
    if (e) next.set("email", e);
    return `/operator/reports/no-cobrados?${next.toString()}`;
  };

  return (
    <div className="flex-1 p-4 md:p-6 max-w-5xl mx-auto w-full">
      <Link
        href="/operator/reports"
        className="font-mono text-[10px] tracking-wider uppercase text-op-muted hover:text-op-text"
      >
        {t("uncollectedBack")}
      </Link>
      <div className="font-display text-3xl tracking-[-0.015em] mt-2 mb-1">
        {t("uncollectedTitle")}
      </div>
      <p className="text-sm text-op-muted mb-5">
        {t.rich("uncollectedIntro", {
          strong: (chunks) => <strong>{chunks}</strong>,
        })}
      </p>

      {/* Filtros */}
      <div className="rounded-2xl border border-op-border bg-op-surface p-4 mb-4">
        <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-3">
          {t("filters")}
        </div>
        <div className="flex flex-wrap gap-3 items-start">
          <FilterField label={t("filterPeriod")}>
            {(["today", "7d", "30d", "month"] as RangeKey[]).map((r) => (
              <FilterChip
                key={r}
                href={buildHref({ range: r })}
                active={range === r}
              >
                {rangeLabel(r)}
              </FilterChip>
            ))}
          </FilterField>
          <FilterField label={t("filterKind")}>
            <FilterChip href={buildHref({ kind: undefined })} active={!kindFilter}>
              {t("filterBoth")}
            </FilterChip>
            <FilterChip href={buildHref({ kind: "cancel" })} active={kindFilter === "cancel"} tone="danger">
              {t("filterCancel")}
            </FilterChip>
            <FilterChip href={buildHref({ kind: "comp" })} active={kindFilter === "comp"} tone="terracotta">
              {t("filterComp")}
            </FilterChip>
          </FilterField>
          {emailFilter && (
            <FilterField label={t("filterWaiter", { email: emailFilter })}>
              <FilterChip
                href={buildHref({ email: undefined })}
                active={false}
              >
                {t("clear")}
              </FilterChip>
            </FilterField>
          )}
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <Kpi label={t("kpiTotalUncollected")} value={fmtCOP(totalLostCents)} />
        <Kpi
          label={t("kpiCancellations")}
          value={`${cancelCount}`}
          hint={fmtCOP(cancelLostCents)}
        />
        <Kpi
          label={t("kpiUncollectedComp")}
          value={`${compCount}`}
          hint={fmtCOP(compLostCents)}
          accent="terracotta"
        />
        <Kpi
          label={t("kpiTotalDishes")}
          value={`${items.length}`}
          hint={t("kpiTotalDishesHint", { range: rangeLabel(range).toLowerCase() })}
        />
      </div>

      {/* Breakdowns */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
        <BreakdownCard
          title={t("breakdownByWaiter")}
          emptyLabel={t("noData")}
          itemsLabel={(count) => t("itemsCount", { count })}
          formatMoney={fmtCOP}
          rows={topEmails.map((e) => ({
            label: e.email,
            count: e.count,
            lostCents: e.lostCents,
            href: buildHref({ email: e.email }),
          }))}
        />
        <BreakdownCard
          title={t("breakdownByReason")}
          emptyLabel={t("noData")}
          itemsLabel={(count) => t("itemsCount", { count })}
          formatMoney={fmtCOP}
          rows={topReasons.map((r) => ({
            label: r.reason,
            count: r.count,
            lostCents: r.lostCents,
          }))}
        />
        <BreakdownCard
          title={t("breakdownByDish")}
          emptyLabel={t("noData")}
          itemsLabel={(count) => t("itemsCount", { count })}
          formatMoney={fmtCOP}
          rows={topDishes.map((d) => ({
            label: d.dish,
            count: d.count,
            lostCents: d.lostCents,
          }))}
        />
      </div>

      {/* Lista detallada */}
      <div className="rounded-2xl border border-op-border bg-op-surface overflow-hidden">
        <div className="px-4 py-3 border-b border-op-border font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
          {t("detailHeader", { count: items.length })}
        </div>
        {items.length === 0 ? (
          <div className="p-8 text-center text-sm text-op-muted">
            {t("noUncollectedFilter")}
          </div>
        ) : (
          <ul className="divide-y divide-op-border">
            {items.map((it) => {
              const kind = (it.cancellationKind ?? "cancel") as "cancel" | "comp";
              const { date, time } = fmtBogotaDateTime(it.cancelledAt!);
              const cost = it.priceCentsSnapshot * it.qty;
              const tableLabel = it.order.table
                ? it.order.table.label
                  ? t("tableLabelWithName", {
                      number: it.order.table.number,
                      label: it.order.table.label,
                    })
                  : t("tableLabel", { number: it.order.table.number })
                : t("noTable");
              return (
                <li key={it.id} className="px-4 py-3 flex gap-3 items-start">
                  <div className="font-mono text-[10px] text-op-muted shrink-0 w-24 leading-snug">
                    {date}
                    <br />
                    {time}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="font-mono tabular text-sm shrink-0">
                        {it.qty}×
                      </span>
                      <span className="text-sm font-medium truncate">
                        {it.nameSnapshot}
                      </span>
                      <KindPill kind={kind} label={kind === "comp" ? t("pillUncollected") : t("pillCancelled")} />
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-[11px] text-op-muted">
                      <span>{tableLabel}</span>
                      <span>·</span>
                      <span className="font-mono">{it.order.shortCode}</span>
                      <span>·</span>
                      <span className="font-mono">
                        {it.cancelledByEmail ?? t("noEmail")}
                      </span>
                    </div>
                    {it.cancellationReason && (
                      <div className="mt-1 text-xs text-op-text italic">
                        {`"${it.cancellationReason}"`}
                      </div>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <div
                      className={
                        "font-mono tabular text-sm " +
                        (kind === "comp" ? "text-terracotta" : "text-danger")
                      }
                    >
                      {fmtCOP(cost)}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function FilterField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col">
      <div className="font-mono text-[9px] tracking-[0.18em] uppercase text-op-muted mb-1.5">
        {label}
      </div>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function FilterChip({
  href,
  active,
  children,
  tone,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
  tone?: "danger" | "terracotta";
}) {
  const activeClass =
    tone === "danger"
      ? "bg-danger text-bone border-danger"
      : tone === "terracotta"
        ? "bg-terracotta text-bone border-terracotta"
        : "bg-ink text-bone border-ink";
  return (
    <Link
      href={href}
      className={
        "h-7 px-3 inline-flex items-center rounded-full text-[11px] border transition-colors " +
        (active
          ? activeClass
          : "bg-op-surface border-op-border text-op-muted hover:text-op-text")
      }
    >
      {children}
    </Link>
  );
}

function Kpi({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: "terracotta";
}) {
  return (
    <div className="rounded-2xl border border-op-border bg-op-surface p-4">
      <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
        {label}
      </div>
      <div
        className={
          "font-display tabular text-2xl mt-1 " +
          (accent === "terracotta" ? "text-terracotta" : "")
        }
      >
        {value}
      </div>
      {hint && (
        <div className="font-mono text-[10px] text-op-muted mt-0.5">{hint}</div>
      )}
    </div>
  );
}

function BreakdownCard({
  title,
  rows,
  emptyLabel,
  itemsLabel,
  formatMoney,
}: {
  title: string;
  emptyLabel: string;
  itemsLabel: (count: number) => string;
  formatMoney: (cents: number) => string;
  rows: Array<{
    label: string;
    count: number;
    lostCents: number;
    href?: string;
  }>;
}) {
  return (
    <div className="rounded-2xl border border-op-border bg-op-surface p-4">
      <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-3">
        {title}
      </div>
      {rows.length === 0 ? (
        <div className="text-xs text-op-muted">{emptyLabel}</div>
      ) : (
        <ul className="divide-y divide-op-border">
          {rows.map((r, idx) => {
            const inner = (
              <>
                <div className="min-w-0 flex-1">
                  <div className="text-sm truncate">{r.label}</div>
                  <div className="font-mono text-[10px] text-op-muted">
                    {itemsLabel(r.count)}
                  </div>
                </div>
                <div className="font-mono tabular text-sm shrink-0">
                  {formatMoney(r.lostCents)}
                </div>
              </>
            );
            return (
              <li key={idx} className="py-2 flex items-center justify-between gap-2">
                {r.href ? (
                  <Link
                    href={r.href}
                    className="flex items-center justify-between gap-2 w-full hover:text-terracotta"
                  >
                    {inner}
                  </Link>
                ) : (
                  inner
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function KindPill({ kind, label }: { kind: "cancel" | "comp"; label: string }) {
  const cls =
    kind === "comp"
      ? "bg-terracotta/15 text-terracotta border-terracotta/30"
      : "bg-danger/10 text-danger border-danger/30";
  return (
    <span
      className={
        "font-mono text-[9px] tracking-wider uppercase px-2 py-0.5 rounded border " +
        cls
      }
    >
      {label}
    </span>
  );
}
