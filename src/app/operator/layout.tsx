import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import Link from "next/link";
import { auth, signOut } from "@/auth";
import { db } from "@/lib/db";
import { IMPERSONATE_COOKIE, getActiveContext } from "@/lib/activeRestaurant";
import { deriveMembershipStatus } from "@/lib/membership";

export default async function OperatorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/signin?callbackUrl=/operator");
  if (session.user.role !== "operator" && session.user.role !== "platform_admin") {
    redirect("/");
  }

  const ctx = await getActiveContext();
  const restaurantId = ctx?.restaurantId ?? null;
  const impersonating = ctx?.impersonating ?? false;

  // Platform admin without impersonation set → nudge them to pick a restaurant.
  if (session.user.role === "platform_admin" && !restaurantId) {
    redirect("/admin/restaurants");
  }

  const tenant = restaurantId
    ? await db.restaurant.findUnique({ where: { id: restaurantId } })
    : null;

  const membership = tenant
    ? deriveMembershipStatus({
        plan: tenant.plan,
        periodEndsAt: tenant.periodEndsAt,
        suspended: tenant.suspended,
      })
    : null;

  // Real operators hit the lock page when suspended.
  // Platform admins impersonating keep access so they can unblock the account.
  if (
    tenant?.suspended &&
    session.user.role === "operator" &&
    !impersonating
  ) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-op-bg p-6 text-op-text">
        <div className="max-w-md text-center space-y-4">
          <div className="font-display text-3xl">Cuenta suspendida</div>
          <p className="text-sm text-op-muted">
            El acceso a <strong>{tenant.name}</strong> está pausado. Ponte en
            contacto con MESAPAY para reactivarla.
          </p>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/" });
            }}
          >
            <button className="h-10 px-4 rounded-xl bg-ink text-bone text-sm font-medium">
              Cerrar sesión
            </button>
          </form>
        </div>
      </div>
    );
  }

  async function stopImpersonating() {
    "use server";
    const jar = await cookies();
    jar.delete(IMPERSONATE_COOKIE);
    redirect("/admin/restaurants");
  }

  return (
    <div className="flex flex-1 flex-col bg-op-bg text-op-text min-h-screen">
      {impersonating && (
        <div className="bg-terracotta text-bone px-6 py-2 flex items-center justify-between text-sm">
          <div>
            <span className="font-mono text-[10px] tracking-wider uppercase opacity-80 mr-2">
              Impersonando
            </span>
            Viendo como operador de <strong>{tenant?.name ?? "…"}</strong>
          </div>
          <form action={stopImpersonating}>
            <button className="font-mono text-[10px] tracking-wider uppercase underline">
              Dejar de impersonar
            </button>
          </form>
        </div>
      )}
      {membership === "vencido" && (
        <div className="bg-danger/15 border-b border-danger/30 text-danger px-6 py-2 text-sm">
          <strong>Mensualidad vencida.</strong> Regulariza el pago para evitar
          la suspensión del acceso.
        </div>
      )}
      {membership === "por_vencer" && (
        <div className="bg-[#C98A2E]/15 border-b border-[#C98A2E]/40 text-[#7F5A1F] px-6 py-2 text-sm">
          Tu mensualidad vence pronto
          {tenant?.periodEndsAt
            ? ` (${new Date(tenant.periodEndsAt).toLocaleDateString("es-CO")})`
            : ""}
          .
        </div>
      )}
      <header className="border-b border-op-border bg-op-surface sticky top-0 z-10">
        <div className="flex items-center justify-between px-6 py-3">
          <div className="flex items-center gap-4">
            <div>
              <div className="font-mono text-[9px] tracking-[0.18em] uppercase text-op-muted">
                Operador · {tenant?.name ?? "Sin restaurante"}
              </div>
              <div className="font-display text-xl tracking-[-0.015em]">MESAPAY</div>
            </div>
            <nav className="flex gap-1 ml-6">
              <NavLink href="/operator">Resumen</NavLink>
              <NavLink href="/operator/kitchen">Cocina</NavLink>
              <NavLink href="/operator/serve">Salón</NavLink>
              <NavLink href="/operator/payments">Cobros</NavLink>
              <NavLink href="/operator/orders">Órdenes</NavLink>
              <NavLink href="/operator/menu">Menú</NavLink>
              <NavLink href="/operator/tables">
                {tenant?.serviceMode === "counter" ? "Mostrador" : "Mesas"}
              </NavLink>
              <NavLink href="/operator/ratings">Reseñas</NavLink>
              <NavLink href="/operator/reports">Cierre</NavLink>
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm">
            {session.user.role === "platform_admin" && (
              <Link
                href="/admin"
                className="font-mono text-[10px] tracking-wider uppercase text-terracotta hover:underline"
              >
                Admin →
              </Link>
            )}
            <span className="text-op-muted">{session.user.email}</span>
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/" });
              }}
            >
              <button className="text-terracotta hover:underline">Salir</button>
            </form>
          </div>
        </div>
      </header>
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="px-3 h-8 inline-flex items-center rounded-lg text-sm text-op-muted hover:text-op-text hover:bg-op-bg"
    >
      {children}
    </Link>
  );
}
