import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import Link from "next/link";
import { auth, signOut } from "@/auth";
import { db } from "@/lib/db";
import { IMPERSONATE_COOKIE, getActiveContext } from "@/lib/activeRestaurant";
import { deriveMembershipStatus } from "@/lib/membership";
import { OperatorMobileMenu } from "./OperatorMobileMenu";

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
        <div className="bg-terracotta text-bone px-4 md:px-6 py-2 flex items-center justify-between gap-3 text-sm">
          <div className="min-w-0">
            <span className="font-mono text-[10px] tracking-wider uppercase opacity-80 mr-2">
              Impersonando
            </span>
            Viendo como operador de <strong>{tenant?.name ?? "…"}</strong>
          </div>
          <form action={stopImpersonating} className="shrink-0">
            <button className="font-mono text-[10px] tracking-wider uppercase underline">
              Dejar de impersonar
            </button>
          </form>
        </div>
      )}
      {membership === "vencido" && (
        <div className="bg-danger/15 border-b border-danger/30 text-danger px-4 md:px-6 py-2 text-sm">
          <strong>Mensualidad vencida.</strong> Regulariza el pago para evitar
          la suspensión del acceso.
        </div>
      )}
      {membership === "por_vencer" && (
        <div className="bg-[#C98A2E]/15 border-b border-[#C98A2E]/40 text-[#7F5A1F] px-4 md:px-6 py-2 text-sm">
          Tu mensualidad vence pronto
          {tenant?.periodEndsAt
            ? ` (${new Date(tenant.periodEndsAt).toLocaleDateString("es-CO")})`
            : ""}
          .
        </div>
      )}
      {(() => {
        // Single source of truth for the nav so desktop inline + mobile
        // drawer render the same items in the same order. Includes
        // Cocina + Bar conditionally based on tenant config.
        const navItems: { href: string; label: string }[] = [
          { href: "/operator", label: "Resumen" },
          { href: "/operator/kitchen", label: "Cocina" },
          ...(tenant?.hasBar
            ? [{ href: "/operator/bar", label: "Bar" }]
            : []),
          { href: "/operator/serve", label: "Salón" },
          { href: "/operator/payments", label: "Cobros" },
          { href: "/operator/orders", label: "Órdenes" },
          { href: "/operator/menu", label: "Menú" },
          { href: "/operator/menus", label: "Cartas" },
          {
            href: "/operator/tables",
            label: tenant?.serviceMode === "counter" ? "Mostrador" : "Mesas",
          },
          { href: "/operator/ratings", label: "Reseñas" },
          { href: "/operator/facturas", label: "Facturas" },
          { href: "/operator/reports", label: "Cierre" },
          { href: "/operator/wallet", label: "Wallet" },
          { href: "/operator/settings", label: "Configuración" },
        ];
        // The signOut server-action gets rendered twice (desktop link +
        // mobile drawer button) so we declare it once and reuse the
        // JSX. Server actions can't be passed across the client/server
        // boundary as functions, but as <form> children they survive.
        const signOutDesktop = (
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/" });
            }}
          >
            <button className="text-terracotta hover:underline">Salir</button>
          </form>
        );
        const signOutMobile = (
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/" });
            }}
          >
            <button
              type="submit"
              className="w-full h-11 rounded-full bg-ink text-bone text-sm font-medium"
            >
              Cerrar sesión
            </button>
          </form>
        );
        return (
          <header className="border-b border-op-border bg-op-surface sticky top-0 z-10">
            <div className="flex items-center justify-between px-4 md:px-6 py-3 gap-3">
              <div className="flex items-center gap-4 md:gap-6 min-w-0">
                <div className="shrink-0 min-w-0">
                  <div className="font-mono text-[9px] tracking-[0.18em] uppercase text-op-muted truncate">
                    Operador · {tenant?.name ?? "Sin restaurante"}
                  </div>
                  <div className="font-display text-xl tracking-[-0.015em]">
                    MESAPAY
                  </div>
                </div>
                {/* Inline nav — desktop only. On mobile the hamburger
                    replaces it (overflow on 14 items is unusable). */}
                <nav className="hidden md:flex gap-1 flex-wrap">
                  {navItems.map((it) => (
                    <NavLink key={it.href} href={it.href}>
                      {it.label}
                    </NavLink>
                  ))}
                </nav>
              </div>
              <div className="hidden md:flex items-center gap-3 text-sm shrink-0">
                {session.user.role === "platform_admin" && (
                  <Link
                    href="/admin"
                    className="font-mono text-[10px] tracking-wider uppercase text-terracotta hover:underline"
                  >
                    Admin →
                  </Link>
                )}
                <span className="text-op-muted">{session.user.email}</span>
                {signOutDesktop}
              </div>
              <OperatorMobileMenu
                tenantName={tenant?.name ?? "Sin restaurante"}
                userEmail={session.user.email}
                isAdmin={session.user.role === "platform_admin"}
                items={navItems}
                signOutAction={signOutMobile}
              />
            </div>
          </header>
        );
      })()}
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
