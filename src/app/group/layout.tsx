import { redirect } from "next/navigation";
import Link from "next/link";
import { auth, signOut } from "@/auth";
import { db } from "@/lib/db";

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
  const session = await auth();
  if (!session?.user) redirect("/signin?callbackUrl=/group");
  if (session.user.role === "platform_admin") redirect("/admin");
  if (session.user.role !== "group_admin") {
    // Operator / mesero / staff van a /operator. Customer queda
    // sin shell — redirige a home.
    redirect(
      session.user.role === "customer" || !session.user.role
        ? "/"
        : "/operator",
    );
  }
  if (!session.user.groupId) {
    // Group admin sin grupo asignado — estado inválido. Devolvemos
    // una vista de error en vez de loopear redirects.
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

  // Resumen del grupo para el header (nombre + count de restaurantes).
  const group = await db.group.findUnique({
    where: { id: session.user.groupId },
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

  return (
    <div className="flex flex-1 flex-col bg-op-bg text-op-text min-h-screen">
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
