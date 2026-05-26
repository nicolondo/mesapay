import Link from "next/link";
import { cookies } from "next/headers";
import { redirect, notFound } from "next/navigation";
import { db } from "@/lib/db";
import { auth } from "@/auth";
import { IMPERSONATE_COOKIE } from "@/lib/activeRestaurant";
import { fmtBogotaDateTime } from "@/lib/bogota";

export const dynamic = "force-dynamic";

/**
 * Admin platform: detalle de un grupo. Muestra la estructura completa
 * (restaurantes asignados, miembros group_admin, razones sociales) y
 * permite impersonar a cualquiera de los restaurantes del grupo
 * directamente sin pasar por /admin/restaurants. Útil para soporte
 * cross-tenant en cadenas.
 */
export default async function GroupDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const group = await db.group.findUnique({
    where: { id },
    include: {
      restaurants: {
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          slug: true,
          plan: true,
          createdAt: true,
        },
      },
      members: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          createdAt: true,
        },
      },
      legalEntities: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          name: true,
          taxId: true,
          dianResolution: true,
          invoicePrefix: true,
          _count: { select: { restaurants: true } },
        },
      },
    },
  });

  if (!group) notFound();

  // Server action: impersonar cualquier restaurante del grupo desde
  // el admin platform. Mismo flujo que /admin/restaurants/[id], sólo
  // que aquí lo lanzamos por restaurante hijo.
  async function impersonateRestaurant(formData: FormData) {
    "use server";
    const session = await auth();
    if (!session?.user || session.user.role !== "platform_admin") {
      redirect("/admin");
    }
    const restaurantId = String(formData.get("restaurantId") ?? "");
    if (!restaurantId) redirect(`/admin/groups/${id}`);
    const jar = await cookies();
    jar.set(IMPERSONATE_COOKIE, restaurantId, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 4,
    });
    redirect("/operator");
  }

  return (
    <div className="flex-1 p-4 md:p-6 max-w-5xl mx-auto w-full">
      <Link
        href="/admin/groups"
        className="font-mono text-[10px] tracking-wider uppercase text-op-muted hover:text-op-text"
      >
        ← Grupos
      </Link>

      <div className="mt-4 mb-6">
        <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
          Plataforma · Grupo
        </div>
        <div className="flex items-baseline gap-3 flex-wrap">
          <div className="font-display text-3xl tracking-[-0.015em]">
            {group.name}
          </div>
          <div className="font-mono text-xs text-op-muted">/{group.slug}</div>
        </div>
        <div className="font-mono text-[11px] text-op-muted mt-1">
          Alta: {fmtBogotaDateTime(group.createdAt).date}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-6">
        <Stat label="Restaurantes" value={group.restaurants.length} />
        <Stat label="Miembros" value={group.members.length} />
        <Stat label="Razones sociales" value={group.legalEntities.length} />
      </div>

      {/* Restaurantes — con botón impersonar por cada uno */}
      <section className="rounded-2xl border border-op-border bg-op-surface overflow-hidden mb-6">
        <div className="px-5 py-3 border-b border-op-border font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
          Restaurantes
        </div>
        {group.restaurants.length === 0 ? (
          <div className="p-6 text-sm text-op-muted text-center">
            Sin restaurantes asignados aún.
          </div>
        ) : (
          <ul className="divide-y divide-op-border">
            {group.restaurants.map((r) => (
              <li
                key={r.id}
                className="p-4 flex items-center gap-3 flex-wrap"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="font-display text-lg truncate">
                      {r.name}
                    </div>
                    <span className="font-mono text-[10px] text-op-muted">
                      /{r.slug}
                    </span>
                    <span className="font-mono text-[10px] uppercase text-op-muted">
                      · {r.plan}
                    </span>
                  </div>
                  <div className="font-mono text-[10px] text-op-muted mt-0.5">
                    Alta {fmtBogotaDateTime(r.createdAt).date}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Link
                    href={`/admin/restaurants/${r.id}`}
                    className="inline-flex items-center justify-center h-8 px-3 rounded-full border border-op-border text-xs font-medium hover:bg-op-bg"
                  >
                    Ficha
                  </Link>
                  <form action={impersonateRestaurant}>
                    <input
                      type="hidden"
                      name="restaurantId"
                      value={r.id}
                    />
                    <button
                      type="submit"
                      className="inline-flex items-center justify-center h-8 px-3 rounded-full bg-ink text-bone text-xs font-medium"
                    >
                      Entrar →
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Miembros del grupo (group_admins típicamente, pero soporta
          cualquier role que haya sido vinculado via groupId). */}
      <section className="rounded-2xl border border-op-border bg-op-surface overflow-hidden mb-6">
        <div className="px-5 py-3 border-b border-op-border font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
          Miembros
        </div>
        {group.members.length === 0 ? (
          <div className="p-6 text-sm text-op-muted text-center">
            Sin miembros. Crea un usuario group_admin desde /admin/groups
            para que pueda entrar a /group.
          </div>
        ) : (
          <ul className="divide-y divide-op-border">
            {group.members.map((m) => (
              <li key={m.id} className="p-4 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm truncate">
                    {m.name ?? <em className="text-op-muted">Sin nombre</em>}
                  </div>
                  <div className="font-mono text-[11px] text-op-muted truncate">
                    {m.email}
                  </div>
                </div>
                <div className="font-mono text-[10px] uppercase text-op-muted shrink-0">
                  {m.role}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Razones sociales del grupo. Cada una puede estar asignada a
          N restaurantes (caso típico: dos locales bajo el mismo NIT). */}
      <section className="rounded-2xl border border-op-border bg-op-surface overflow-hidden">
        <div className="px-5 py-3 border-b border-op-border font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
          Razones sociales
        </div>
        {group.legalEntities.length === 0 ? (
          <div className="p-6 text-sm text-op-muted text-center">
            Sin razones sociales. El group_admin las gestiona desde{" "}
            <span className="font-mono">/group/razones-sociales</span>.
          </div>
        ) : (
          <ul className="divide-y divide-op-border">
            {group.legalEntities.map((le) => (
              <li key={le.id} className="p-4">
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="font-display text-base">{le.name}</div>
                  <span className="font-mono text-[11px] text-op-muted">
                    NIT {le.taxId}
                  </span>
                </div>
                <div className="font-mono text-[10px] text-op-muted mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                  <span>
                    {le._count.restaurants}{" "}
                    {le._count.restaurants === 1
                      ? "restaurante asignado"
                      : "restaurantes asignados"}
                  </span>
                  {le.dianResolution && (
                    <>
                      <span>·</span>
                      <span>Res. DIAN {le.dianResolution}</span>
                    </>
                  )}
                  {le.invoicePrefix && (
                    <>
                      <span>·</span>
                      <span>Prefijo {le.invoicePrefix}</span>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-2xl border border-op-border bg-op-surface p-4">
      <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
        {label}
      </div>
      <div className="font-display text-2xl mt-1 tracking-[-0.015em]">
        {value}
      </div>
    </div>
  );
}
