import { redirect } from "next/navigation";
import Link from "next/link";
import { auth, signOut } from "@/auth";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/signin?callbackUrl=/admin");
  if (session.user.role !== "platform_admin") redirect("/");

  return (
    <div className="flex flex-1 flex-col bg-op-bg text-op-text min-h-screen">
      <header className="border-b border-op-border bg-op-surface sticky top-0 z-10">
        <div className="flex items-center justify-between px-6 py-3">
          <div className="flex items-center gap-4">
            <div>
              <div className="font-mono text-[9px] tracking-[0.18em] uppercase text-terracotta">
                Plataforma · Admin
              </div>
              <div className="font-display text-xl tracking-[-0.015em]">MESAPAY</div>
            </div>
            <nav className="flex gap-1 ml-6">
              <NavLink href="/admin">Resumen</NavLink>
              <NavLink href="/admin/restaurants">Restaurantes</NavLink>
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <Link
              href="/operator"
              className="font-mono text-[10px] tracking-wider uppercase text-op-muted hover:text-op-text"
            >
              ← Operador
            </Link>
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
