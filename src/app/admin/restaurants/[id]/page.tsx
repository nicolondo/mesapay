import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { auth } from "@/auth";
import { fmtBogotaDateTime } from "@/lib/bogota";
import { fmtCOP } from "@/lib/format";
import { IMPERSONATE_COOKIE } from "@/lib/activeRestaurant";
import {
  STATUS_LABEL,
  deriveMembershipStatus,
  type MembershipStatus,
} from "@/lib/membership";
import {
  PickupSchedulePanel,
  PickupToggle,
  PlanEditor,
  RecordPaymentForm,
  ServiceModePicker,
  SuspendButton,
} from "./BillingPanel";
import { UsersPanel } from "./UsersPanel";
import { RestaurantNameEditor } from "./RestaurantNameEditor";

export const dynamic = "force-dynamic";

const METHOD_LABEL: Record<string, string> = {
  manual_cash: "Efectivo",
  manual_transfer: "Transferencia",
  wompi: "Wompi",
};

const PLAN_LABEL: Record<string, string> = {
  trial: "Prueba",
  basic: "Básico",
  pro: "Pro",
};

export default async function RestaurantDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [rest, operators, counts, lastOrder, firstOrder, payments] =
    await Promise.all([
      db.restaurant.findUnique({ where: { id } }),
      db.user.findMany({
        where: {
          restaurantId: id,
          role: { in: ["operator", "terminal"] },
        },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      }),
      db.restaurant.findUnique({
        where: { id },
        select: {
          _count: {
            select: { tables: true, menuItems: true, orders: true, categories: true },
          },
        },
      }),
      db.order.findFirst({
        where: { restaurantId: id },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true, status: true, totalCents: true },
      }),
      db.order.findFirst({
        where: { restaurantId: id },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      }),
      db.membershipPayment.findMany({
        where: { restaurantId: id },
        orderBy: { createdAt: "desc" },
        take: 12,
      }),
    ]);

  if (!rest) notFound();

  const paidCount = await db.order.count({
    where: { restaurantId: id, status: "paid" },
  });

  const status = deriveMembershipStatus({
    plan: rest.plan,
    periodEndsAt: rest.periodEndsAt,
    suspended: rest.suspended,
  });

  async function impersonate() {
    "use server";
    const session = await auth();
    if (!session?.user || session.user.role !== "platform_admin") {
      redirect("/admin");
    }
    const jar = await cookies();
    jar.set(IMPERSONATE_COOKIE, id, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 4,
    });
    redirect("/operator");
  }

  return (
    <div className="flex-1 p-6 max-w-5xl mx-auto w-full">
      <Link
        href="/admin/restaurants"
        className="font-mono text-[10px] tracking-wider uppercase text-op-muted hover:text-op-text"
      >
        ← Restaurantes
      </Link>

      <div className="flex items-start justify-between mt-4 mb-6 gap-3">
        <div className="min-w-0 flex-1">
          <RestaurantNameEditor
            restaurantId={rest.id}
            initialName={rest.name}
          />
          <div className="font-mono text-xs text-op-muted mt-1">/{rest.slug}</div>
          <div className="font-mono text-[11px] text-op-muted mt-1">
            Alta: {fmtBogotaDateTime(rest.createdAt).date}
          </div>
        </div>
        <form action={impersonate}>
          <button
            type="submit"
            className="h-10 px-4 rounded-xl bg-ink text-bone text-sm font-medium"
          >
            Entrar como operador →
          </button>
        </form>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        <Stat label="Operadores" value={operators.length} />
        <Stat label="Categorías" value={counts?._count.categories ?? 0} />
        <Stat label="Platos" value={counts?._count.menuItems ?? 0} />
        <Stat label="Mesas" value={counts?._count.tables ?? 0} />
        <Stat label="Órdenes" value={counts?._count.orders ?? 0} />
      </div>

      <div className="rounded-2xl border border-op-border bg-op-surface p-5 mb-4">
        <div className="flex items-start justify-between mb-3">
          <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
            Facturación
          </div>
          <div className="flex items-center gap-2">
            <StatusPill status={status} />
            <SuspendButton restaurantId={id} suspended={rest.suspended} />
          </div>
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          <div className="space-y-2">
            <Row label="Plan">{PLAN_LABEL[rest.plan]}</Row>
            <Row label="Mensualidad">
              {rest.monthlyPriceCents > 0
                ? fmtCOP(rest.monthlyPriceCents)
                : "Sin costo"}
            </Row>
            <Row label="Periodo hasta">
              {rest.periodEndsAt
                ? fmtBogotaDateTime(rest.periodEndsAt).date
                : "—"}
            </Row>
            {rest.periodEndsAt && (
              <Row label="Días restantes">
                <DaysLeft date={rest.periodEndsAt} />
              </Row>
            )}
          </div>
          <div>
            <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-2">
              Plan
            </div>
            <PlanEditor
              restaurantId={id}
              plan={rest.plan}
              monthlyPriceCents={rest.monthlyPriceCents}
            />
          </div>
        </div>

        <div className="mt-5 pt-4 border-t border-op-border">
          <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-2">
            Registrar pago
          </div>
          <RecordPaymentForm
            restaurantId={id}
            suggestedAmountCents={rest.monthlyPriceCents}
          />
        </div>

        <div className="mt-5 pt-4 border-t border-op-border">
          <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-2">
            Historial ({payments.length})
          </div>
          {payments.length === 0 ? (
            <div className="text-sm text-op-muted">Sin pagos registrados.</div>
          ) : (
            <ul className="divide-y divide-op-border">
              {payments.map((p) => (
                <li
                  key={p.id}
                  className="py-2 flex items-start justify-between text-sm gap-4"
                >
                  <div>
                    <div className="font-mono tabular">
                      {fmtCOP(p.amountCents)}{" "}
                      <span className="text-op-muted">
                        · {METHOD_LABEL[p.method] ?? p.method}
                      </span>
                    </div>
                    <div className="font-mono text-[11px] text-op-muted">
                      {fmtBogotaDateTime(p.periodStart).date} →{" "}
                      {fmtBogotaDateTime(p.periodEnd).date} · registrado por{" "}
                      {p.recordedByEmail}
                    </div>
                    {p.note && (
                      <div className="text-[11px] text-op-muted mt-0.5">
                        {p.note}
                      </div>
                    )}
                  </div>
                  <div className="font-mono text-[10px] text-op-muted shrink-0">
                    {fmtBogotaDateTime(p.createdAt).date}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="rounded-2xl border border-op-border bg-op-surface p-4 mb-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
              Pagos
            </div>
            <div className="text-sm mt-1">
              {rest.kushkiOnboardingStatus === "active"
                ? "Activo. El comercio puede recibir pagos."
                : rest.kushkiOnboardingStatus === "not_started"
                  ? "Aún no ha iniciado el onboarding."
                  : `Estado: ${rest.kushkiOnboardingStatus}`}
            </div>
          </div>
          <Link
            href={`/admin/restaurants/${id}/pagos`}
            className="h-9 px-4 rounded-full bg-ink text-bone text-sm font-medium inline-flex items-center"
          >
            Ver detalles →
          </Link>
        </div>
      </div>

      <div className="rounded-2xl border border-op-border bg-op-surface p-4 mb-4">
        <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-3">
          Modo de servicio
        </div>
        <ServiceModePicker
          restaurantId={id}
          serviceMode={rest.serviceMode}
        />
        <div className="text-[11px] text-op-muted mt-2">
          {rest.serviceMode === "counter"
            ? "Cliente ordena desde un QR único, sin mesas. Útil para food trucks y mostradores."
            : "Cada mesa tiene su propio QR. El cliente escanea desde su puesto."}
        </div>
      </div>

      <div className="rounded-2xl border border-op-border bg-op-surface p-4 mb-4">
        <div className="flex items-start justify-between gap-4 mb-2">
          <div>
            <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
              Pedido anticipado
            </div>
            <div className="text-sm mt-1">
              Cliente escanea un QR, prepaga y recoge en el mostrador.
            </div>
          </div>
          <PickupToggle
            restaurantId={id}
            pickupEnabled={rest.pickupEnabled}
          />
        </div>
        <div className="text-[11px] text-op-muted mt-2">
          El QR de recogida se imprime desde Mesas. El tiempo de espera se
          calcula en vivo según lo que esté en cocina.
        </div>
        {rest.pickupEnabled && (
          <div className="mt-5 pt-4 border-t border-op-border">
            <PickupSchedulePanel
              restaurantId={id}
              pickupHours={
                rest.pickupHours as Record<string, unknown> | null
              }
              pickupMaxEtaMinutes={rest.pickupMaxEtaMinutes}
            />
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-op-border bg-op-surface p-4 mb-4">
        <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-3">
          Actividad
        </div>
        <Row label="Primera orden">
          {firstOrder
            ? fmtBogotaDateTime(firstOrder.createdAt).date
            : "—"}
        </Row>
        <Row label="Última orden">
          {lastOrder ? (
            <>
              {fmtBogotaDateTime(lastOrder.createdAt).date}{" "}
              <span className="text-op-muted">
                ({lastOrder.status})
              </span>
            </>
          ) : (
            "—"
          )}
        </Row>
        <Row label="Pagadas">{paidCount}</Row>
      </div>

      <UsersPanel
        restaurantId={id}
        initialUsers={operators.map((u) => ({
          id: u.id,
          email: u.email,
          name: u.name,
          role: u.role as "operator" | "terminal",
          createdAt: u.createdAt.toISOString(),
        }))}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-op-border bg-op-surface p-3">
      <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
        {label}
      </div>
      <div className="font-display text-2xl mt-1">{value}</div>
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex justify-between py-1.5 text-sm border-t border-op-border first:border-t-0">
      <div className="text-op-muted">{label}</div>
      <div>{children}</div>
    </div>
  );
}

function DaysLeft({ date }: { date: Date }) {
  const days = Math.floor((date.getTime() - Date.now()) / 86400000);
  if (days < 0)
    return (
      <span className="text-danger font-mono tabular">
        vencido hace {Math.abs(days)}d
      </span>
    );
  if (days === 0)
    return <span className="text-[#7F5A1F] font-mono tabular">vence hoy</span>;
  return <span className="font-mono tabular">{days} días</span>;
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
        "font-mono text-[10px] tracking-wider uppercase px-2 py-1 rounded border " +
        map[status]
      }
    >
      {STATUS_LABEL[status]}
    </span>
  );
}
