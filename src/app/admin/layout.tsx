import { redirect } from "next/navigation";
import Link from "next/link";
import { auth, signOut } from "@/auth";
import { AdminMobileMenu } from "./AdminMobileMenu";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/signin?callbackUrl=/admin");
  if (session.user.role !== "platform_admin") redirect("/");

  // The signout server-action is the same one rendered inline in the
  // desktop header AND inside the mobile drawer. We define it once and
  // pass both shapes around so there's a single source of truth for
  // the logout flow.
  const signOutFormDesktop = (
    <form
      action={async () => {
        "use server";
        await signOut({ redirectTo: "/" });
      }}
    >
      <button className="text-terracotta hover:underline">Salir</button>
    </form>
  );
  const signOutFormMobile = (
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
    <div className="flex flex-1 flex-col bg-op-bg text-op-text min-h-screen">
      <header className="border-b border-op-border bg-op-surface sticky top-0 z-10">
        <div className="flex items-center justify-between px-4 md:px-6 py-3 gap-3">
          <div className="flex items-center gap-4 md:gap-6 min-w-0">
            <div className="shrink-0">
              <div className="font-mono text-[9px] tracking-[0.18em] uppercase text-terracotta">
                Plataforma · Admin
              </div>
              <div className="font-display text-xl tracking-[-0.015em]">
                MESAPAY
              </div>
            </div>
            {/* Inline nav hidden on small screens — see AdminMobileMenu
                for the hamburger drawer that takes its place. */}
            <nav className="hidden md:flex gap-1">
              <NavLink href="/admin">Resumen</NavLink>
              <NavLink href="/admin/restaurants">Restaurantes</NavLink>
              <NavLink href="/admin/plans">Planes</NavLink>
              <NavLink href="/admin/audit">Audit</NavLink>
            </nav>
          </div>
          <div className="hidden md:flex items-center gap-3 text-sm">
            <Link
              href="/operator"
              className="font-mono text-[10px] tracking-wider uppercase text-op-muted hover:text-op-text"
            >
              ← Operador
            </Link>
            <span className="text-op-muted">{session.user.email}</span>
            {signOutFormDesktop}
          </div>
          <AdminMobileMenu
            userEmail={session.user.email}
            signOutAction={signOutFormMobile}
          />
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
