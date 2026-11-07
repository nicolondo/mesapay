import { requestTime } from "@/lib/requestTime";
import Link from "next/link";
import { getTranslations, getLocale } from "next-intl/server";
import { db } from "@/lib/db";
import { Icon } from "@/components/ui/Icon";
import { fmtBogotaDateTime } from "@/lib/bogota";
import {
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
  searchParams: Promise<{ ok?: string; q?: string | string[]; country?: string | string[]; city?: string | string[]; welcome?: string }>;
}) {
  const sp = await searchParams;
  const now = await requestTime();
  const t = await getTranslations("opAdmin");
  const ui = await getTranslations("adminWorkspacePage");
  const tDeleted = await getTranslations("adminDelete");
  const tl = await getTranslations("location");
  const locale = await getLocale();

  // Filtros de ubicación (opcionales). País en ISO uppercase; ciudad
  // case-insensitive porque viene del autocompletado / texto libre.
  const q = typeof sp.q === "string" ? sp.q.trim().slice(0, 120) : "";
  const country = typeof sp.country === "string" ? sp.country.trim().toUpperCase() || undefined : undefined;
  const city = typeof sp.city === "string" ? sp.city.trim() || undefined : undefined;
  const hasFilters = Boolean(q || country || city);
  const where = {
    ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" as const } }, { slug: { contains: q, mode: "insensitive" as const } }] } : {}),
    ...(country ? { country } : {}),
    ...(city ? { city: { equals: city, mode: "insensitive" as const } } : {}),
  };

  const [restaurants, paidCounts, lastOrders, firstOrders, operatorCounts] =
    await Promise.all([
      db.restaurant.findMany({
        where,
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

  // Valores distintos para los selects del filtro — sobre TODOS los
  // restaurantes (no sólo los filtrados), para no perder opciones al
  // refinar. Descartamos nulls/vacíos.
  const [countryRows, cityRows] = await Promise.all([
    db.restaurant.findMany({
      where: { country: { not: null } },
      select: { country: true },
      distinct: ["country"],
    }),
    db.restaurant.findMany({
      where: { city: { not: null } },
      select: { city: true },
      distinct: ["city"],
    }),
  ]);
  const regionNames = (() => {
    try {
      return new Intl.DisplayNames([locale], { type: "region" });
    } catch {
      return null;
    }
  })();
  const countryOptions = countryRows
    .map((r) => r.country!)
    .filter(Boolean)
    .map((code) => ({
      code,
      label: (regionNames?.of(code) ?? code) || code,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, locale));
  const cityOptions = cityRows
    .map((r) => r.city!)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, locale));

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
  const membershipByRest = new Map(restaurants.map((r) => [r.id, deriveMembershipStatus({
    plan: r.plan, periodEndsAt: r.periodEndsAt, suspended: r.suspended, now: new Date(now),
  })]));
  const membershipCounts = Array.from(membershipByRest.values()).reduce(
    (counts, status) => ({ ...counts, [status]: counts[status] + 1 }),
    { al_dia: 0, trial: 0, por_vencer: 0, vencido: 0, suspendido: 0 },
  );

  return (
    <div className="mp-page">
      <header className="mp-page-header flex-wrap">
        <div className="min-w-0 max-w-2xl">
          <p className="mp-eyebrow">{ui("listEyebrow")}</p>
          <h1 className="mp-page-title">{t("restaurantsTitle")}</h1>
          <p className="mp-page-description">{ui("listIntro")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <Link
            href="/admin/restaurants/eliminados"
            prefetch={false}
            className="inline-flex min-h-11 items-center text-xs font-medium text-op-muted underline-offset-4 hover:text-op-text hover:underline"
          >
            {tDeleted("listLink")}
          </Link>
          <Link
            href="/admin/restaurants/new"
            prefetch={false}
            className="mp-btn mp-btn--primary"
          >
            {t("newRestaurant")}
          </Link>
        </div>
      </header>

      {sp.ok && (
        <div role="status" className="mb-6 rounded-xl border border-ok/30 bg-ok/10 text-[#1E5339] px-4 py-3 text-sm leading-relaxed">
          {t.rich("restaurantCreated", {
            slug: sp.ok,
            code: (chunks) => <span className="font-mono">{chunks}</span>,
          })}
          {sp.welcome && <p className="mt-2">{t(sp.welcome === "sent" ? "welcomeEmailSent" : "welcomeEmailPending")}</p>}
        </div>
      )}

        <form
          method="GET"
          action="/admin/restaurants"
          role="search"
          aria-label={ui("searchLabel")}
          className="mb-6 grid grid-cols-2 gap-4 rounded-2xl border border-op-border bg-op-surface p-4 xl:grid-cols-[minmax(200px,1.6fr)_minmax(140px,1fr)_minmax(140px,1fr)_auto] xl:items-end print:hidden"
        >
          <label className="flex min-w-0 flex-col gap-2 col-span-2 xl:col-span-1">
            <span className="text-xs font-medium text-op-muted">{ui("searchLabel")}</span>
            <span className="relative">
              <Icon name="search" className="pointer-events-none absolute left-3 top-3 text-op-muted" />
              <input name="q" type="search" defaultValue={q} maxLength={120} placeholder={ui("searchPlaceholder")}
                className="h-11 w-full rounded-lg border border-op-border bg-op-bg pl-10 pr-3 text-sm text-op-text placeholder:text-op-muted" />
            </span>
          </label>
          <label className="flex min-w-0 flex-col gap-2">
            <span className="text-xs font-medium text-op-muted">
              {tl("filterCountry")}
            </span>
            <select
              name="country"
              defaultValue={country ?? ""}
              className="h-11 w-full rounded-lg border border-op-border bg-op-bg px-3 text-sm"
            >
              <option value="">{tl("allCountries")}</option>
              {countryOptions.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-2">
            <span className="text-xs font-medium text-op-muted">
              {tl("filterCity")}
            </span>
            <select
              name="city"
              defaultValue={city ?? ""}
              className="h-11 w-full rounded-lg border border-op-border bg-op-bg px-3 text-sm"
            >
              <option value="">{tl("allCities")}</option>
              {cityOptions.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-wrap gap-2 col-span-2 xl:col-span-1">
            <button
              type="submit"
              className="mp-btn mp-btn--primary flex-1 xl:flex-none"
            >
              {ui("searchAction")}
            </button>
            {hasFilters && (
              <Link
                href="/admin/restaurants"
                prefetch={false}
                className="mp-btn mp-btn--secondary flex-1 xl:flex-none"
              >
                {t("clearFilters")}
              </Link>
            )}
          </div>
        </form>

      <section aria-label={ui("resultsLabel")} className="mb-7">
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-op-border bg-op-border lg:grid-cols-4 print:grid-cols-4">
          <DirectoryStat label={ui("resultsLabel")} value={restaurants.length} />
          <DirectoryStat label={ui("currentLabel")} value={membershipCounts.al_dia} />
          <DirectoryStat label={ui("trialLabel")} value={membershipCounts.trial} />
          <DirectoryStat label={ui("attentionLabel")} value={membershipCounts.por_vencer + membershipCounts.vencido + membershipCounts.suspendido} hint={ui("attentionHint")} />
        </dl>
        <p className="mt-2 text-xs leading-relaxed text-op-muted">{ui("viewScope")}</p>
      </section>

      {restaurants.length === 0 ? (
        <section className="rounded-2xl border border-dashed border-op-border bg-op-surface px-6 py-12 text-center">
          <Icon name={hasFilters ? "search" : "business"} className="mx-auto mb-4 h-8 w-8 text-op-muted" />
          <h2 className="mb-2 text-xl font-semibold tracking-tight">{hasFilters ? ui("filteredEmptyTitle") : t("noAccountsTitle")}</h2>
          <p className="mx-auto mb-6 max-w-md text-sm leading-relaxed text-op-muted">
            {hasFilters ? ui("filteredEmptyBody") : t("noAccountsBody")}
          </p>
          <Link
            href={hasFilters ? "/admin/restaurants" : "/admin/restaurants/new"}
            prefetch={false}
            className="mp-btn mp-btn--primary"
          >
            {hasFilters ? t("clearFilters") : t("newRestaurant")}
          </Link>
        </section>
      ) : (
        <>
        <div className="mb-4">
          <h2 className="text-base font-semibold tracking-tight">{ui("resultsCount", { count: restaurants.length })}</h2>
          <p className="mt-1 text-sm text-op-muted">{ui("resultsHelp")}</p>
        </div>
        {/* Mobile: card list — much friendlier than horizontal-scrolling
            a 10-column table. Shows the same data the operator needs
            to triage at a glance (name, plan/status pills, key counts). */}
        <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:hidden print:hidden">
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
            const membership = membershipByRest.get(r.id)!;
            return (
              <li
                key={r.id}
                className="relative min-w-0 rounded-2xl border border-op-border bg-op-surface p-5 transition-colors hover:border-terracotta/35"
              >
                {/* La cabecera (nombre · slug · badges) sigue siendo el enlace
                    al comercio. Las seis cifras van PLEGADAS por defecto: con
                    todas abiertas cada tarjeta medía ~250px y en el celular
                    apenas cabían dos comercios por pantalla. Se despliegan con
                    el chevrón de la derecha; es un <details> nativo, sin JS,
                    así que funciona antes de hidratar y no convierte la página
                    en componente cliente. El summary va posicionado en la
                    esquina para que el enlace y el toggle no se pisen. */}
                <Link
                  href={`/admin/restaurants/${r.id}`}
                  prefetch={false}
                  className="block min-w-0 pr-12 active:opacity-70 transition-opacity"
                >
                  <h3 className="break-words text-base font-semibold leading-snug tracking-tight">
                    {r.name}
                  </h3>
                  <div className="font-mono text-[11px] text-op-muted truncate">
                    /{r.slug}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <MembershipPill status={membership} plan={r.plan} t={t} inline />
                    <StatePill state={state} t={t} />
                  </div>
                </Link>
                <details className="group">
                  <summary
                    aria-label={t("cardToggleFigures")}
                    title={t("cardToggleFigures")}
                    className="absolute top-4 right-4 flex h-11 w-11 cursor-pointer list-none items-center justify-center rounded-lg border border-op-border bg-op-bg text-op-muted [&::-webkit-details-marker]:hidden"
                  >
                    <svg
                      aria-hidden
                      viewBox="0 0 20 20"
                      className="h-4 w-4 transition-transform group-open:rotate-180"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.75}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M5 7.5l5 5 5-5" />
                    </svg>
                  </summary>
                  <div className="mt-4 grid grid-cols-3 gap-2 border-t border-op-border pt-4 text-xs">
                    <MiniStat label={t("colOperators")} value={ops} />
                    <MiniStat label={t("colMenu")} value={r._count.menuItems} />
                    <MiniStat label={t("colTables")} value={r._count.tables} />
                    <MiniStat label={t("colOrders")} value={r._count.orders} />
                    <MiniStat label={t("colPaid")} value={paid} />
                    <MiniStat
                      label={t("colLast")}
                      value={last ? <RelTime now={now} date={last} t={t} /> : "—"}
                    />
                  </div>
                </details>
              </li>
            );
          })}
        </ul>

        {/* The desktop rail reduces content width: keep compact cards on
            tablets and contain horizontal scrolling inside the desktop table. */}
        <div className="hidden rounded-2xl border border-op-border bg-op-surface xl:block print:block print:overflow-visible">
          <div role="region" aria-label={ui("tableLabel")} tabIndex={0} className="overflow-x-auto rounded-2xl print:overflow-visible">
          <table className="w-full min-w-[1000px] text-sm print:min-w-0 print:text-[9px]">
            <caption className="sr-only">{ui("tableLabel")}</caption>
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
                const membership = membershipByRest.get(r.id)!;
                return (
                  <tr
                    key={r.id}
                    className="border-t border-op-border hover:bg-op-bg"
                  >
                    <Td>
                      <Link
                        href={`/admin/restaurants/${r.id}`}
                        prefetch={false}
                        className="block min-w-[160px] max-w-[240px] print:min-w-0 print:break-all"
                      >
                        <div className="break-words font-semibold hover:underline">
                          {r.name}
                        </div>
                        <div className="font-mono text-[11px] text-op-muted print:break-all print:text-[8px]">
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
                        <RelTime now={now} date={last} t={t} />
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
        </div>
        </>
      )}
    </div>
  );
}

function DirectoryStat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="min-w-0 bg-op-surface px-4 py-5 sm:px-5">
      <dt className="text-xs font-medium text-op-muted">{label}</dt>
      <dd className="mt-2">
        <span className="text-3xl font-semibold tabular leading-none tracking-tight print:text-xl">{value}</span>
        {hint && <span className="mt-2 block text-xs leading-relaxed text-op-muted">{hint}</span>}
      </dd>
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
      <div className="text-[11px] text-op-muted">
        {label}
      </div>
      <div className="mt-1 truncate text-sm font-medium tabular">{value}</div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th scope="col" className="px-3 py-3 text-xs font-medium text-op-muted print:break-words print:px-1 print:py-2 print:text-[8px]">
      {children}
    </th>
  );
}
function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-3 py-3 align-top print:min-w-0 print:break-words print:px-1 print:py-2">{children}</td>;
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
        "text-xs font-medium px-2 py-1 rounded border " +
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
  inline,
}: {
  status: MembershipStatus;
  plan: "trial" | "basic" | "pro";
  t: Translate;
  /** Tarjeta móvil: plan y estado en fila (la tabla los apila). */
  inline?: boolean;
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
    <div
      className={
        inline ? "flex flex-wrap items-center gap-1.5" : "flex flex-col gap-1"
      }
    >
      <span className="text-xs font-medium">{planLabel[plan]}</span>
      <span
        className={
          "text-[11px] font-medium px-2 py-1 rounded border inline-block w-fit " +
          map[status]
        }
      >
        {t("ms_" + status)}
      </span>
    </div>
  );
}

function RelTime({ date, t, now }: { date: Date; t: Translate; now: number }) {
  const days = Math.floor((now - date.getTime()) / 86400000);
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
