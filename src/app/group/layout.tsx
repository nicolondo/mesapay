import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import Link from "next/link";
import { signOut } from "@/auth";
import { db } from "@/lib/db";
import {
  IMPERSONATE_GROUP_COOKIE,
  getActiveGroupShellContext,
} from "@/lib/activeRestaurant";

/**
 * Layout server-gated para /group/*. Sólo group_admin entra.
 * platform_admin redirige a /admin (su propio shell). Otros roles
 * van a /operator (que ya tiene su propia auth).
 *
 * Header similar al de /admin: marca + nav + identidad + signout.
 * El switcher entre restaurantes y la lista del grupo viven en
 * /group (la página landing), no en el layout.
 */
export default async function GroupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await getActiveGroupShellContext();
  if (!ctx) {
    // Resolver redirect por role: customer/anon → home; staff →
    // /operator; group_admin sin groupId → mostrar mismo error que
    // antes; platform_admin sin cookie → /admin (no debería entrar
    // a /group sin haber clickeado impersonar).
    // El helper devolvió null entonces dejamos que la lógica de
    // redirect específica viva acá.
    const { auth } = await import("@/auth");
    const session = await auth();
    if (!session?.user) redirect("/signin?callbackUrl=/group");
    if (session.user.role === "platform_admin") redirect("/admin");
    if (session.user.role === "group_admin" && !session.user.groupId) {
      return (
        <div className="min-h-screen bg-op-bg text-op-text flex items-center justify-center p-6">
          <div className="max-w-md text-center">
            <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
              Sin grupo
            </div>
            <h1 className="font-display text-2xl mb-2">
              Tu cuenta no tiene grupo asignado
            </h1>
            <p className="text-sm text-op-muted">
              Hablá con MESAPAY para que vinculen tu usuario a un grupo
              de restaurantes.
            </p>
          </div>
        </div>
      );
    }
    redirect(
      session.user.role === "customer" || !session.user.role
        ? "/"
        : "/operator",
    );
  }

  const { session, groupId, isImpersonating } = ctx;

  // Resumen del grupo para el header (nombre + count de restaurantes).
  const group = await db.group.findUnique({
    where: { id: groupId },
    select: {
      id: true,
      name: true,
      _count: { select: { restaurants: true } },
    },
  });
  if (!group) {
    return (
      <div className="min-h-screen bg-op-bg text-op-text flex items-center justify-center p-6">
        <div className="max-w-md text-center">
          <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
            Error
          </div>
          <h1 className="font-display text-2xl mb-2">
            Grupo no encontrado
          </h1>
        </div>
      </div>
    );
  }

  const signOutForm = (
    <form
      action={async () => {
        "use server";
        await signOut({ redirectTo: "/" });
      }}
    >
      <button className="text-terracotta hover:underline">Salir</button>
    </form>
  );

  // Server action: limpiar la cookie de impersonate de grupo y volver
  // a /admin/groups. Solo se renderiza si platform_admin entró acá vía
  // impersonate; group_admins normales no la ven.
  async function stopImpersonatingGroup() {
    "use server";
    const jar = await cookies();
    jar.delete(IMPERSONATE_GROUP_COOKIE);
    redirect("/admin/groups");
  }

  return (
    <div className="flex flex-1 flex-col bg-op-bg text-op-text min-h-screen">
      {isImpersonating && (
        <div className="bg-terracotta text-bone px-4 md:px-6 py-2 flex items-center justify-between gap-3 text-sm flex-wrap">
          <div className="min-w-0 flex items-center gap-3 flex-wrap">
            <span className="font-mono text-[10px] tracking-wider uppercase opacity-80">
              Impersonando grupo
            </span>
            <span className="truncate">
              Viendo como group_admin de <strong>{group.name}</strong>
            </span>
          </div>
          <form action={stopImpersonatingGroup} className="shrink-0">
            <button className="font-mono text-[10px] tracking-wider uppercase underline">
              Volver al admin
            </button>
          </form>
        </div>
      )}
      <header className="border-b border-op-border bg-op-surface sticky top-0 z-10">
        <div className="flex items-center justify-between px-4 md:px-6 py-3 gap-3">
          <div className="flex items-center gap-4 md:gap-6 min-w-0">
            <div className="shrink-0">
              <div className="font-mono text-[9px] tracking-[0.18em] uppercase text-terracotta">
                Grupo · {group._count.restaurants}{" "}
                {group._count.restaurants === 1 ? "local" : "locales"}
              </div>
              <div className="font-display text-xl tracking-[-0.015em]">
                {group.name}
              </div>
            </div>
            <nav className="hidden md:flex gap-1">
              <NavLink href="/group">Restaurantes</NavLink>
              <NavLink href="/group/razones-sociales">
                Razones sociales
              </NavLink>
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="hidden md:inline text-op-muted">
              {session.user.email}
            </span>
            {signOutForm}
          </div>
        </div>
      </header>
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  );
}

function NavLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="px-3 h-8 inline-flex items-center rounded-lg text-sm text-op-muted hover:text-op-text hover:bg-op-bg"
    >
      {children}
    </Link>
  );
}
