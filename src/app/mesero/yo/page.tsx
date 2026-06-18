import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import { db } from "@/lib/db";
import {
  getCurrentMeseroShift,
  startOfMeseroDay,
} from "@/lib/meseroShift";
import {
  resolveShiftPolicy,
  resolveTipPolicy,
} from "@/lib/staffPolicies";
import { isCashMethod } from "@/lib/shift";
import { YoClient } from "./YoClient";
import { MisMesasClient, type MesaPick } from "./MisMesasClient";

export const dynamic = "force-dynamic";

/**
 * Vista personal del mesero — identidad + asignaciones + stats del
 * turno (o del día) + control de turno personal cuando aplica.
 *
 * El cliente (YoClient) maneja la parte reactiva: abrir / cerrar
 * turno + refresh de stats. El server pre-llena con la primera
 * snapshot para evitar un loading vacío al abrir el tab.
 */
export default async function YoPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin?callbackUrl=/mesero/yo");

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      restaurantId: true,
      assignedTableNumbers: true,
      restaurant: {
        select: {
          name: true,
          tipPolicy: true,
          shiftPolicy: true,
          businessDayCutoffHour: true,
        },
      },
    },
  });
  if (!user) redirect("/signin");

  const tipPolicy = resolveTipPolicy(user.restaurant?.tipPolicy);
  const shiftPolicy = resolveShiftPolicy(user.restaurant?.shiftPolicy);

  // Pre-cargamos stats iniciales — el client refresca a partir de
  // estos sin esperar a la primera GET. Solo aplicable cuando el
  // user es mesero (otros roles ven la vista sin stats).
  let initialStats: {
    sinceIso: string;
    tipsCents: number | null;
    tipsRawCents: number;
    salesCents: number;
    paymentCount: number;
    tableCount: number;
    shift: {
      id: string;
      openedAtIso: string;
      openingCashCents: number;
      cashCollectedCents: number;
    } | null;
  } | null = null;
  if (user.role === "mesero" && user.restaurantId) {
    const openShift =
      shiftPolicy === "by_waiter"
        ? await getCurrentMeseroShift(user.id)
        : null;
    const since = startOfMeseroDay(
      openShift?.openedAt ?? null,
      user.restaurant?.businessDayCutoffHour ?? 0,
    );
    const payments = await db.payment.findMany({
      where: {
        collectedByUserId: user.id,
        status: "approved",
        settledAt: { gte: since },
      },
      select: {
        amountCents: true,
        tipCents: true,
        method: true,
        order: { select: { tableId: true } },
      },
    });
    const tipsCentsRaw = payments.reduce((s, p) => s + p.tipCents, 0);
    const cashCollectedCents = payments.reduce(
      (s, p) => (isCashMethod(p.method) ? s + p.amountCents : s),
      0,
    );
    const tableSet = new Set<string>();
    for (const p of payments)
      if (p.order?.tableId) tableSet.add(p.order.tableId);
    initialStats = {
      sinceIso: since.toISOString(),
      tipsCents: tipPolicy === "by_waiter" ? tipsCentsRaw : null,
      tipsRawCents: tipsCentsRaw,
      salesCents: payments.reduce(
        (s, p) => s + (p.amountCents - p.tipCents),
        0,
      ),
      paymentCount: payments.length,
      tableCount: tableSet.size,
      shift: openShift
        ? {
            id: openShift.id,
            openedAtIso: openShift.openedAt.toISOString(),
            openingCashCents: openShift.openingCashCents,
            cashCollectedCents,
          }
        : null,
    };
  }

  // Picker de auto-asignación de mesas (solo mesero). Trae todas las mesas
  // del local + quién las tiene + si están ocupadas, para que el mesero
  // pueda tomarlas/soltarlas desde su perfil.
  let meseroTables: MesaPick[] = [];
  if (user.role === "mesero" && user.restaurantId) {
    const rid = user.restaurantId;
    const [tables, activeOrders, holders] = await Promise.all([
      db.table.findMany({
        where: { restaurantId: rid, number: { gte: 0 } },
        orderBy: { number: "asc" },
        select: { number: true, label: true },
      }),
      db.order.findMany({
        where: { restaurantId: rid, status: { notIn: ["paid", "cancelled"] } },
        select: { table: { select: { number: true } } },
      }),
      db.user.findMany({
        where: { restaurantId: rid, role: "mesero" },
        select: { id: true, name: true, email: true, assignedTableNumbers: true },
      }),
    ]);
    const occupied = new Set<number>();
    for (const o of activeOrders) if (o.table) occupied.add(o.table.number);
    const mineSet = new Set(user.assignedTableNumbers);
    meseroTables = tables.map((t) => {
      const mine = mineSet.has(t.number);
      let holderName: string | null = null;
      if (!mine) {
        const h = holders.find(
          (u) => u.id !== user.id && u.assignedTableNumbers.includes(t.number),
        );
        if (h) holderName = h.name?.trim() || h.email.split("@")[0];
      }
      return {
        number: t.number,
        label: t.label,
        occupied: occupied.has(t.number),
        mine,
        holderName,
      };
    });
  }

  const displayName = user.name?.trim() || user.email.split("@")[0];
  const initials = (user.name?.trim() || user.email)
    .split(/\s+/)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? "")
    .join("");

  // Server action para cerrar sesión — se pasa al client y el form
  // wrapper la dispara. Mantenemos así para no exponer una API
  // adicional.
  async function doSignOut() {
    "use server";
    await signOut({ redirectTo: "/signin" });
  }

  return (
    <div className="p-5 max-w-md mx-auto w-full space-y-5">
      <div className="font-display text-3xl mb-1">Yo</div>

      {/* Identidad */}
      <section className="rounded-2xl border border-hairline bg-paper p-5 flex items-center gap-4">
        <div className="w-14 h-14 rounded-full bg-ink text-bone flex items-center justify-center font-display text-xl shrink-0">
          {initials || "?"}
        </div>
        <div className="min-w-0">
          <div className="font-display text-xl truncate">{displayName}</div>
          <div className="font-mono text-[11px] text-muted truncate">
            {user.email}
          </div>
          {user.restaurant?.name && (
            <div className="font-mono text-[10px] tracking-wider uppercase text-muted-2 mt-1 truncate">
              {user.restaurant.name}
            </div>
          )}
        </div>
      </section>

      {/* Stats + turno (solo para mesero). Para operator/admin que
          accedan a /mesero/yo por dogfooding, mostramos solo
          identidad + mesas + cerrar sesión. */}
      {user.role === "mesero" && initialStats && (
        <YoClient
          tipPolicy={tipPolicy}
          shiftPolicy={shiftPolicy}
          initial={initialStats}
        />
      )}

      {/* Mis mesas — interactivo para mesero (auto-asignación); read-only
          para operator/admin que entren por dogfooding. */}
      {user.role === "mesero" ? (
        <MisMesasClient tables={meseroTables} />
      ) : (
        <section className="rounded-2xl border border-hairline bg-paper p-5">
          <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-muted mb-2">
            Mis mesas
          </div>
          {user.assignedTableNumbers.length === 0 ? (
            <p className="text-sm text-ink/80">
              Atiendes <strong>todas</strong> las mesas del restaurante.
            </p>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(48px,1fr))] gap-1.5">
              {user.assignedTableNumbers.map((n) => (
                <div
                  key={n}
                  className="h-10 rounded-lg bg-ivory border border-hairline flex items-center justify-center text-sm font-medium tabular"
                >
                  {n}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <form action={doSignOut}>
        <button
          type="submit"
          className="w-full h-12 rounded-2xl border border-hairline bg-paper text-ink text-sm font-medium"
        >
          Cerrar sesión
        </button>
      </form>
    </div>
  );
}
