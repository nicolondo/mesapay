import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { listAuditEvents, labelForKind } from "@/lib/auditLog";
import { fmtBogotaDateTime } from "@/lib/bogota";

export const dynamic = "force-dynamic";

/**
 * /admin/audit — historial de acciones administrativas con filtros
 * por kind y restaurante (vía query string). Limitado a 200 filas
 * para que la página cargue rápido; si en el futuro se necesita
 * paginación se agrega.
 *
 * Sin sub-componente cliente — los filtros se aplican vía
 * query params (links) para que el SSR mantenga el control y se
 * pueda compartir/bookmarkear el filtro actual.
 */
export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<{
    kind?: string;
    restaurantId?: string;
    actorEmail?: string;
  }>;
}) {
  const { kind, restaurantId, actorEmail } = await searchParams;
  const t = await getTranslations("opAdmin");

  const events = await listAuditEvents({
    kind: kind || undefined,
    restaurantId: restaurantId || undefined,
    actorEmail: actorEmail || undefined,
    limit: 200,
  });

  // Para el dropdown de filtros — kinds y restaurants únicos en los
  // últimos 200 eventos. Suficiente para uso típico; no vale la
  // pena pegarle full a la tabla para popular un select.
  const uniqueKinds = Array.from(new Set(events.map((e) => e.kind))).sort();
  const uniqueRestaurants = Array.from(
    new Map(
      events
        .filter((e) => e.restaurant)
        .map((e) => [e.restaurant!.id, e.restaurant!]),
    ).values(),
  ).sort((a, b) => a.name.localeCompare(b.name));

  const filterActive = !!(kind || restaurantId || actorEmail);

  return (
    <div className="flex-1 p-4 md:p-6 max-w-5xl mx-auto w-full">
      <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
        {t("platformLabel")}
      </div>
      <div className="font-display text-3xl tracking-[-0.015em] mb-1">
        {t("auditTitle")}
      </div>
      <p className="text-sm text-op-muted mb-5">
        {t("auditIntro")}
      </p>

      {/* Filtros */}
      <div className="rounded-2xl border border-op-border bg-op-surface p-4 mb-4">
        <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-3">
          {t("filters")}
        </div>
        <div className="flex flex-wrap gap-3 items-end">
          <FilterField label={t("filterAction")}>
            <FilterLink
              href={buildHref({ kind: undefined, restaurantId, actorEmail })}
              active={!kind}
            >
              {t("filterAll")}
            </FilterLink>
            {uniqueKinds.map((k) => (
              <FilterLink
                key={k}
                href={buildHref({ kind: k, restaurantId, actorEmail })}
                active={kind === k}
              >
                {labelForKind(k)}
              </FilterLink>
            ))}
          </FilterField>
          {uniqueRestaurants.length > 0 && (
            <FilterField label={t("filterMerchant")}>
              <FilterLink
                href={buildHref({
                  kind,
                  restaurantId: undefined,
                  actorEmail,
                })}
                active={!restaurantId}
              >
                {t("filterAllMerchants")}
              </FilterLink>
              {uniqueRestaurants.map((r) => (
                <FilterLink
                  key={r.id}
                  href={buildHref({
                    kind,
                    restaurantId: r.id,
                    actorEmail,
                  })}
                  active={restaurantId === r.id}
                >
                  {r.name}
                </FilterLink>
              ))}
            </FilterField>
          )}
          {filterActive && (
            <Link
              href="/admin/audit"
              className="font-mono text-[10px] tracking-wider uppercase text-terracotta hover:underline"
            >
              {t("clearFilters")}
            </Link>
          )}
        </div>
      </div>

      {/* Lista */}
      <div className="rounded-2xl border border-op-border bg-op-surface overflow-hidden">
        <div className="px-5 py-3 border-b border-op-border flex items-center justify-between">
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
            {t("eventsCount", { count: events.length })}
          </div>
        </div>
        {events.length === 0 ? (
          <div className="p-8 text-sm text-op-muted text-center">
            {t("noEventsFilter")}
          </div>
        ) : (
          <ul className="divide-y divide-op-border">
            {events.map((e) => {
              const { date, time } = fmtBogotaDateTime(e.occurredAt);
              return (
                <li key={e.id} className="px-5 py-3 flex gap-4 items-start">
                  <div className="font-mono text-[10px] text-op-muted shrink-0 w-32 leading-snug">
                    {date}
                    <br />
                    {time}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm">{e.summary}</div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-[11px] text-op-muted">
                      <span className="font-mono">{e.actorEmail}</span>
                      <span aria-hidden>{"·"}</span>
                      <span className="font-mono uppercase">
                        {e.actorRole}
                      </span>
                      <span aria-hidden>{"·"}</span>
                      <Link
                        href={buildHref({
                          kind: e.kind,
                          restaurantId,
                          actorEmail,
                        })}
                        className="font-mono hover:text-op-text"
                      >
                        {e.kind}
                      </Link>
                      {e.restaurant && (
                        <>
                          <span aria-hidden>{"·"}</span>
                          <Link
                            href={`/admin/restaurants/${e.restaurant.id}`}
                            className="hover:text-op-text"
                          >
                            {e.restaurant.name}
                          </Link>
                        </>
                      )}
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

function FilterLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={
        "h-7 px-3 inline-flex items-center rounded-full text-[11px] border transition-colors " +
        (active
          ? "bg-ink text-bone border-ink"
          : "bg-op-bg border-op-border text-op-muted hover:text-op-text")
      }
    >
      {children}
    </Link>
  );
}

function buildHref(params: {
  kind?: string;
  restaurantId?: string;
  actorEmail?: string;
}): string {
  const search = new URLSearchParams();
  if (params.kind) search.set("kind", params.kind);
  if (params.restaurantId) search.set("restaurantId", params.restaurantId);
  if (params.actorEmail) search.set("actorEmail", params.actorEmail);
  const qs = search.toString();
  return qs ? `/admin/audit?${qs}` : "/admin/audit";
}
