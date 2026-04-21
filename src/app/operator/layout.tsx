import { redirect } from "next/navigation";
import Link from "next/link";
import { auth, signOut } from "@/auth";
import { db } from "@/lib/db";

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

  const tenant = session.user.restaurantId
    ? await db.restaurant.findUnique({ where: { id: session.user.restaurantId } })
    : null;

  return (
    <div className="flex flex-1 flex-col bg-op-bg text-op-text min-h-screen">
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
              <NavLink href="/operator/payments">Cobros</NavLink>
              <NavLink href="/operator/orders">Órdenes</NavLink>
              <NavLink href="/operator/menu">Menú</NavLink>
              <NavLink href="/operator/tables">Mesas</NavLink>
              <NavLink href="/operator/reports">Cierre</NavLink>
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm">
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
