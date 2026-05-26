import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { auth } from "@/auth";
import { fmtCOP } from "@/lib/format";
import {
  IMPERSONATE_COOKIE,
  getActiveContext,
} from "@/lib/activeRestaurant";
import {
  deriveMembershipStatus,
  STATUS_LABEL,
  type MembershipStatus,
} from "@/lib/membership";

export const dynamic = "force-dynamic";

/**
 * /group — landing del group_admin. Muestra:
 *   - 3 KPIs del día agregados sobre todos los restaurantes del grupo
 *     (ventas, count de transacciones, top local)
 *   - Grid de restaurantes con KPIs per-local + status de membresía
 *   - Click en un restaurante → setea IMPERSONATE_COOKIE y va a /operator
 *   - CTA "Crear restaurante" (fase 1, abre wizard)
 *
 * Auth la maneja el layout. Acá asumimos ya tenemos un group_admin
 * autenticado con groupId válido.
 */
export default async function GroupHome() {
  const ctx = await getActiveContext();
  if (!ctx || !ctx.session.user.groupId) {
    redirect("/signin?callbackUrl=/group");
  }
  const groupId = ctx.session.user.groupId;

  const now = new Date();
  const startOfDay = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    0,
    0,
    0,
    0,
  );

  const restaurants = await db.restaurant.findMany({
    where: { groupId },
    orderBy: { name: "asc" },
    select: {
      id: true,
      slug: true,
      name: true,
      plan: true,
      monthlyPriceCents: true,
      periodEndsAt: true,
      suspended: true,
      logoUrl: true,
    },
  });

  // KPIs del día por restaurante. Una sola query agregada con groupBy
  // sobre Payment.orderId, y luego mapeamos orderIds → restaurantId.
  // Para grupos chicos (<10 locales) es eficiente; si crece mucho se
  // puede materializar en una tabla resumida.
  const ordersToday = await db.order.findMany({
    where: {
      restaurantId: { in: restaurants.map((r) => r.id) },
      paidAt: { gte: startOfDay },
    },
    select: {
      id: true,
      restaurantId: true,
      payments: {
        where: { status: "approved", settledAt: { gte: startOfDay } },
        select: { amountCents: true },
      },
    },
  });

  type RestStats = {
    salesCents: number;
    transactionCount: number;
  };
  const statsByRest = new Map<string, RestStats>();
  for (const r of restaurants) {
    statsByRest.set(r.id, { salesCents: 0, transactionCount: 0 });
  }
  let totalSalesCents = 0;
  let totalTransactions = 0;
  for (const o of ordersToday) {
    const s = statsByRest.get(o.restaurantId);
    if (!s) continue;
    for (const p of o.payments) {
      s.salesCents += p.amountCents;
      totalSalesCents += p.amountCents;
      s.transactionCount += 1;
      totalTransactions += 1;
    }
  }

  // Top local del día (mayor ventas).
  let topRestaurantId: string | null = null;
  let topSales = 0;
  for (const [id, s] of statsByRest) {
    if (s.salesCents > topSales) {
      topSales = s.salesCents;
      topRestaurantId = id;
    }
  }
  const topRestaurantName = topRestaurantId
    ? restaurants.find((r) => r.id === topRestaurantId)?.name ?? "—"
    : "—";

  /**
   * Server action: impersonar un restaurante del grupo. Setea la
   * cookie y redirige al /operator de ese local. La validación de
   * que el restaurante pertenece al grupo se hace tanto acá (defensa
   * server-side) como en getActiveContext (al leer la cookie).
   */
  async function impersonate(formData: FormData) {
    "use server";
    const targetId = String(formData.get("restaurantId") ?? "");
    if (!targetId) return;
    const session = await auth();
    if (
      !session?.user ||
      session.user.role !== "group_admin" ||
      !session.user.groupId
    ) {
      return;
    }
    const rest = await db.restaurant.findUnique({
      where: { id: targetId },
      select: { groupId: true },
    });
    if (!rest || rest.groupId !== session.user.groupId) {
      // No es de este grupo → ignorar.
      return;
    }
    const jar = await cookies();
    jar.set(IMPERSONATE_COOKIE, targetId, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      // Sesión de impersonación de 8h — suficiente para un turno
      // operativo, después tienen que re-elegir.
      maxAge: 60 * 60 * 8,
    });
    redirect("/operator");
  }

  return (
    <div className="flex-1 p-4 md:p-6 max-w-5xl mx-auto w-full">
      <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
        Pulso del grupo
      </div>
      <div className="font-display text-3xl tracking-[-0.015em] mb-1">
        Hoy
      </div>
      <p className="text-sm text-op-muted mb-5">
        Cifras consolidadas de tus {restaurants.length}{" "}
        {restaurants.length === 1 ? "restaurante" : "restaurantes"} desde
        las 00:00.
      </p>

      {/* KPIs del día agregados */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
        <Kpi label="Ventas del grupo" value={fmtCOP(totalSalesCents)} />
        <Kpi
          label="Transacciones"
          value={String(totalTransactions)}
          hint={
            totalTransactions === 0
              ? "Sin transacciones aún"
              : `Ticket promedio ${fmtCOP(Math.round(totalSalesCents / Math.max(1, totalTransactions)))}`
          }
        />
        <Kpi label="Top local del día" value={topRestaurantName} hint={topSales > 0 ? fmtCOP(topSales) : "—"} />
      </div>

      <div className="flex items-center justify-between mb-3">
        <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
          Restaurantes
        </div>
        {/* Botón crear queda como link a wizard — la página se
            arma en el siguiente commit. */}
        <Link
          href="/group/restaurants/new"
          className="h-9 px-4 rounded-full bg-ink text-bone text-sm font-medium inline-flex items-center"
        >
          + Crear restaurante
        </Link>
      </div>

      {restaurants.length === 0 ? (
        <div className="rounded-2xl border border-op-border bg-op-surface p-8 text-center text-sm text-op-muted">
          Aún no hay restaurantes en este grupo. Tap en "Crear restaurante" para empezar.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {restaurants.map((r) => {
            const stats =
              statsByRest.get(r.id) ?? { salesCents: 0, transactionCount: 0 };
            const status = deriveMembershipStatus({
              plan: r.plan,
              periodEndsAt: r.periodEndsAt,
              suspended: r.suspended,
              now,
            });
            return (
              <RestaurantCard
                key={r.id}
                id={r.id}
                slug={r.slug}
                name={r.name}
                logoUrl={r.logoUrl}
                status={status}
                salesCents={stats.salesCents}
                transactionCount={stats.transactionCount}
                impersonate={impersonate}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function Kpi({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-2xl border border-op-border bg-op-surface p-5">
      <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
        {label}
      </div>
      <div className="font-display tabular text-2xl mt-1 truncate">
        {value}
      </div>
      {hint && (
        <div className="font-mono text-[10px] text-op-muted mt-1">{hint}</div>
      )}
    </div>
  );
}

function RestaurantCard({
  id,
  slug,
  name,
  logoUrl,
  status,
  salesCents,
  transactionCount,
  impersonate,
}: {
  id: string;
  slug: string;
  name: string;
  logoUrl: string | null;
  status: MembershipStatus;
  salesCents: number;
  transactionCount: number;
  impersonate: (formData: FormData) => Promise<void>;
}) {
  return (
    <div className="rounded-2xl border border-op-border bg-op-surface p-4 flex items-start gap-3">
      <div className="w-12 h-12 rounded-xl bg-op-bg border border-op-border flex items-center justify-center overflow-hidden shrink-0">
        {logoUrl ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={logoUrl}
            alt={name}
            className="w-full h-full object-contain p-1"
          />
        ) : (
          <span className="font-display text-base text-op-muted">
            {name.charAt(0).toUpperCase()}
          </span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="font-display text-lg truncate">{name}</div>
          <StatusPill status={status} />
        </div>
        <div className="font-mono text-[11px] text-op-muted">/{slug}</div>
        <div className="mt-2 flex items-baseline gap-3 flex-wrap">
          <div>
            <div className="font-mono text-[9px] tracking-wider uppercase text-op-muted">
              Hoy
            </div>
            <div className="font-mono tabular text-sm">
              {fmtCOP(salesCents)}
            </div>
          </div>
          <div>
            <div className="font-mono text-[9px] tracking-wider uppercase text-op-muted">
              Tx
            </div>
            <div className="font-mono tabular text-sm">{transactionCount}</div>
          </div>
        </div>
        <form action={impersonate} className="mt-3">
          <input type="hidden" name="restaurantId" value={id} />
          <button
            type="submit"
            className="h-9 px-4 rounded-full bg-ink text-bone text-sm font-medium hover:bg-ink/90"
          >
            Entrar como operador →
          </button>
        </form>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: MembershipStatus }) {
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
        "font-mono text-[10px] tracking-wider uppercase px-2 py-0.5 rounded border " +
        map[status]
      }
    >
      {STATUS_LABEL[status]}
    </span>
  );
}
