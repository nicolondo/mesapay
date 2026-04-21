import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import { db } from "@/lib/db";
import { fmtCOP } from "@/lib/format";
import { fmtBogotaDateTime } from "@/lib/bogota";
import { ProfileForm } from "./ProfileForm";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
  open: "Abierta",
  placed: "En cocina",
  in_kitchen: "En cocina",
  ready: "Lista",
  served: "Servida",
  paying: "Pagando",
  paid: "Pagada",
  cancelled: "Cancelada",
};

export default async function CustomerHome() {
  const session = await auth();
  if (!session?.user) redirect("/signin?callbackUrl=/me");

  const userId = session.user.id;

  const [user, orders] = await Promise.all([
    db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        marketingOptIn: true,
        createdAt: true,
      },
    }),
    db.order.findMany({
      where: { customerId: userId },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: {
        id: true,
        shortCode: true,
        status: true,
        totalCents: true,
        createdAt: true,
        paidAt: true,
        restaurant: { select: { slug: true, name: true } },
        table: { select: { number: true } },
        _count: { select: { items: true } },
      },
    }),
  ]);

  if (!user) redirect("/signin?callbackUrl=/me");

  return (
    <main className="flex-1 bg-bone">
      <div className="max-w-3xl mx-auto px-6 py-10">
        <div className="flex items-start justify-between mb-8">
          <div>
            <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-muted">
              MESAPAY · Mi cuenta
            </div>
            <h1 className="font-display text-3xl tracking-[-0.015em] mt-1">
              {user.name ?? "Hola"}
            </h1>
            <div className="font-mono text-[11px] text-muted mt-1">
              {user.email}
            </div>
          </div>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/" });
            }}
          >
            <button
              type="submit"
              className="h-10 px-4 rounded-full border border-hairline text-sm text-ink bg-paper"
            >
              Salir
            </button>
          </form>
        </div>

        <section className="mb-10">
          <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted mb-3">
            Tus órdenes
          </div>
          {orders.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-hairline bg-paper p-8 text-center">
              <div className="text-sm text-muted">
                Aún no tienes órdenes. Cuando escanees un QR en un restaurante
                MESAPAY, tus cuentas aparecerán aquí.
              </div>
            </div>
          ) : (
            <ul className="space-y-2">
              {orders.map((o) => {
                const dt = fmtBogotaDateTime(o.createdAt);
                const paid = o.status === "paid";
                return (
                  <li
                    key={o.id}
                    className="rounded-xl border border-hairline bg-paper p-4 flex items-start justify-between gap-4"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-display text-lg tracking-[-0.01em]">
                          {o.restaurant.name}
                        </span>
                        <span
                          className={
                            "font-mono text-[9px] tracking-wider uppercase px-2 py-0.5 rounded border " +
                            (paid
                              ? "bg-ok/10 text-[#1E5339] border-ok/30"
                              : o.status === "cancelled"
                                ? "bg-danger/10 text-danger border-danger/25"
                                : "bg-paper text-muted border-hairline")
                          }
                        >
                          {STATUS_LABEL[o.status] ?? o.status}
                        </span>
                      </div>
                      <div className="font-mono text-[11px] text-muted mt-1 truncate">
                        {o.table.number > 0
                          ? `Mesa ${o.table.number}`
                          : "Mostrador"}{" "}
                        · {o.shortCode} · {o._count.items} ítems
                      </div>
                      <div className="font-mono text-[10px] text-muted mt-0.5">
                        {dt.date} · {dt.time}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-display text-xl tabular">
                        {fmtCOP(o.totalCents)}
                      </div>
                      {!paid && o.status !== "cancelled" && (
                        <Link
                          href={`/t/${o.restaurant.slug}/order/${o.id}`}
                          className="font-mono text-[10px] tracking-wider uppercase text-terracotta hover:underline"
                        >
                          Abrir →
                        </Link>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section>
          <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted mb-3">
            Tu perfil
          </div>
          <ProfileForm
            initial={{
              name: user.name ?? "",
              phone: user.phone ?? "",
              marketingOptIn: user.marketingOptIn,
            }}
          />
        </section>
      </div>
    </main>
  );
}
