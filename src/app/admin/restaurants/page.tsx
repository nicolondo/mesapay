import Link from "next/link";
import { db } from "@/lib/db";
import { fmtBogotaDateTime } from "@/lib/bogota";

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
    <div className="flex-1 p-6 max-w-7xl mx-auto w-full">
      <div className="flex items-baseline justify-between mb-6">
        <div>
          <div className="font-display text-3xl">Restaurantes</div>
          <div className="text-sm text-op-muted mt-1">
            {restaurants.length}{" "}
            {restaurants.length === 1 ? "cuenta" : "cuentas"} en la plataforma
          </div>
        </div>
        <Link
          href="/admin/restaurants/new"
          className="h-10 px-4 rounded-xl bg-ink text-bone text-sm font-medium inline-flex items-center"
        >
          + Nuevo restaurante
        </Link>
      </div>

      {sp.ok && (
        <div className="mb-4 rounded-lg border border-ok/30 bg-ok/10 text-[#1E5339] px-3 py-2 text-sm">
          Restaurante <span className="font-mono">{sp.ok}</span> creado.
        </div>
      )}

      {restaurants.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-op-border bg-op-surface p-10 text-center">
          <div className="font-display text-2xl mb-1">Todavía no hay cuentas</div>
          <div className="text-sm text-op-muted mb-4">
            Crea el primer restaurante para empezar.
          </div>
          <Link
            href="/admin/restaurants/new"
            className="h-10 px-4 rounded-xl bg-ink text-bone text-sm font-medium inline-flex items-center"
          >
            + Nuevo restaurante
          </Link>
        </div>
      ) : (
        <div className="rounded-2xl border border-op-border bg-op-surface overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-op-bg">
              <tr className="text-left">
                <Th>Restaurante</Th>
                <Th>Alta</Th>
                <Th>Operadores</Th>
                <Th>Menú</Th>
                <Th>Mesas</Th>
                <Th>Órdenes</Th>
                <Th>Pagadas</Th>
                <Th>Última</Th>
                <Th>Estado</Th>
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
                          1ra orden: {bogotaDate(first)}
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
                        <RelTime date={last} />
                      ) : (
                        <span className="text-op-muted">—</span>
                      )}
                    </Td>
                    <Td>
                      <StatePill state={state} />
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
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

function StatePill({ state }: { state: State }) {
  const map: Record<State, { label: string; cls: string }> = {
    activo: {
      label: "Activo",
      cls: "bg-[#2E6B4C]/12 text-[#1E5339] border-[#2E6B4C]/35",
    },
    en_uso: {
      label: "En uso",
      cls: "bg-[#C98A2E]/15 text-[#7F5A1F] border-[#C98A2E]/50",
    },
    configurando: {
      label: "Configurando",
      cls: "bg-terracotta/10 text-terracotta border-terracotta/30",
    },
    inactivo: {
      label: "Inactivo",
      cls: "bg-danger/10 text-danger border-danger/25",
    },
    nuevo: {
      label: "Sin operador",
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

function RelTime({ date }: { date: Date }) {
  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  const label =
    days === 0
      ? "hoy"
      : days === 1
        ? "ayer"
        : days < 7
          ? `hace ${days}d`
          : days < 30
            ? `hace ${Math.floor(days / 7)}sem`
            : bogotaDate(date);
  return <span className="font-mono text-xs text-op-muted">{label}</span>;
}
