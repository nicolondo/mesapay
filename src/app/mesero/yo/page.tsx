import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Vista personal del mesero — esqueleto inicial.
 *
 * Hoy muestra solo identidad, mesas asignadas y "Próximamente" para
 * turnos / propinas (esos datos llegan cuando agreguemos
 * Payment.collectedByUserId + MeseroShift en el siguiente sprint).
 *
 * Reemplaza el tab "Cobros" (que era una tabla de pagos diseñada
 * para desktop y no aportaba en mobile). La info de cobros
 * pendientes ya vive en Salón.
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
      restaurant: { select: { name: true } },
    },
  });
  if (!user) redirect("/signin");

  const displayName = user.name?.trim() || user.email.split("@")[0];
  const initials = (user.name?.trim() || user.email)
    .split(/\s+/)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? "")
    .join("");

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

      {/* Mesas asignadas */}
      <section className="rounded-2xl border border-hairline bg-paper p-5">
        <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-muted mb-2">
          Mis mesas
        </div>
        {user.assignedTableNumbers.length === 0 ? (
          <p className="text-sm text-ink/80">
            Atiendes <strong>todas</strong> las mesas del restaurante. El
            operador puede asignarte una sección desde configuración.
          </p>
        ) : (
          <>
            <p className="text-xs text-muted mb-3">
              Tu sección — {user.assignedTableNumbers.length}{" "}
              {user.assignedTableNumbers.length === 1 ? "mesa" : "mesas"}.
            </p>
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
          </>
        )}
      </section>

      {/* Próximamente — placeholders honestos para que el mesero sepa
          qué viene. Vienen con Sprint 2 cuando se enganche tracking
          de quién cobra cada Payment + modelo de turno por mesero. */}
      <section className="rounded-2xl border border-dashed border-hairline bg-paper/50 p-5 space-y-3">
        <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-muted">
          Próximamente
        </div>
        <ul className="text-sm text-ink/70 space-y-2">
          <li className="flex items-start gap-2">
            <span aria-hidden>⏱️</span>
            <span>
              <strong>Abrir / cerrar mi turno</strong> — registra cuándo
              empezaste y terminaste.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <span aria-hidden>💰</span>
            <span>
              <strong>Propinas del día</strong> — todo lo que recibiste
              acumulado por turno.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <span aria-hidden>📊</span>
            <span>
              <strong>Resumen</strong> — mesas atendidas, ventas y
              tiempo trabajado al cerrar tu turno.
            </span>
          </li>
        </ul>
      </section>

      {/* Cerrar sesión también vive en el header pero en mobile es
          útil tenerlo al alcance al final del scroll del tab Yo. */}
      <form
        action={async () => {
          "use server";
          await signOut({ redirectTo: "/signin" });
        }}
      >
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
