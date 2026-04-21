import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { auth } from "@/auth";
import { fmtBogotaDateTime } from "@/lib/bogota";
import { IMPERSONATE_COOKIE } from "@/lib/activeRestaurant";

export const dynamic = "force-dynamic";

export default async function RestaurantDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [rest, operators, counts, lastOrder, firstOrder] = await Promise.all([
    db.restaurant.findUnique({ where: { id } }),
    db.user.findMany({
      where: { restaurantId: id, role: "operator" },
      select: { id: true, email: true, name: true, createdAt: true },
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
  ]);

  if (!rest) notFound();

  const paidCount = await db.order.count({
    where: { restaurantId: id, status: "paid" },
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

      <div className="flex items-start justify-between mt-4 mb-6">
        <div>
          <div className="font-display text-3xl">{rest.name}</div>
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

      <div className="rounded-2xl border border-op-border bg-op-surface p-4">
        <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-3">
          Operadores
        </div>
        {operators.length === 0 ? (
          <div className="text-sm text-op-muted">Sin operadores asignados.</div>
        ) : (
          <ul className="divide-y divide-op-border">
            {operators.map((u) => (
              <li key={u.id} className="py-2 flex justify-between text-sm">
                <div>
                  <div className="font-medium">{u.name ?? u.email}</div>
                  <div className="font-mono text-[11px] text-op-muted">
                    {u.email}
                  </div>
                </div>
                <div className="font-mono text-[11px] text-op-muted">
                  {fmtBogotaDateTime(u.createdAt).date}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
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
