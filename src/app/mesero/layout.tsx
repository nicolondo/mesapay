import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";

/**
 * Mesero layout — mobile-first PWA wrapper. Reaches into the diner side
 * of the floor: Salón (kitchen-ready items to deliver), Cobros (cuentas
 * pidiendo pago), Mesas (live state of every table). No top nav — the
 * mesero lives in this bottom-tab world.
 *
 * Allowed roles: mesero (primary), operator + platform_admin (so an
 * owner/admin can dogfood without flipping accounts).
 */
export default async function MeseroLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/signin?callbackUrl=/mesero/salon");
  const role = session.user.role;
  if (
    role !== "mesero" &&
    role !== "operator" &&
    role !== "platform_admin"
  ) {
    redirect("/");
  }

  return (
    <div className="flex flex-col min-h-[100dvh] bg-paper">
      {/* Compact header — restaurant identity + signout. No nav links;
          everything happens in the bottom tabs. */}
      <header className="px-4 py-3 border-b border-hairline bg-bone flex items-center justify-between">
        <div className="font-display text-lg">Mesero</div>
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/signin" });
          }}
        >
          <button
            type="submit"
            className="text-xs text-op-muted hover:text-ink"
          >
            Salir
          </button>
        </form>
      </header>

      {/* Content area with safe padding for the bottom nav. */}
      <main className="flex-1 pb-24">{children}</main>

      {/* Bottom navigation — Salón, Cobros, Mesas. Sticky at the bottom
          with safe-area inset so it sits above the iOS home-indicator. */}
      <nav
        className="fixed bottom-0 inset-x-0 bg-bone/95 backdrop-blur border-t border-hairline z-40"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <ul className="grid grid-cols-3 max-w-md mx-auto">
          <TabLink href="/mesero/salon" label="Salón" icon="🍽️" />
          <TabLink href="/mesero/cobros" label="Cobros" icon="💵" />
          <TabLink href="/mesero/mesas" label="Mesas" icon="🪑" />
        </ul>
      </nav>
    </div>
  );
}

function TabLink({
  href,
  label,
  icon,
}: {
  href: string;
  label: string;
  icon: string;
}) {
  // Active styling is purely visual — Next.js handles client-side
  // routing on Link tap. We can't read the pathname server-side here
  // without making this a client component, so we keep both tabs in
  // the same visual state and rely on the page itself to communicate
  // "where you are". Cheap and works without an extra component.
  return (
    <li>
      <Link
        href={href}
        className="flex flex-col items-center justify-center py-2.5 px-2 text-[11px] font-medium text-op-muted hover:text-ink active:scale-95 transition-all"
      >
        <span aria-hidden className="text-xl leading-none mb-0.5">
          {icon}
        </span>
        {label}
      </Link>
    </li>
  );
}
