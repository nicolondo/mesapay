import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import { PushSetup } from "./PushSetup";

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
          everything happens in the bottom tabs.

          `viewport-fit=cover` + iOS "black-translucent" status bar
          style means our page content sits UNDER the system clock /
          notch by default. Padding-top of env(safe-area-inset-top)
          pushes the header below it so the title isn't behind the
          time. The padding is on the same element as bg-bone, so the
          bone color extends up under the status bar — clean look on
          installed PWA + harmless 0 padding in a regular browser tab. */}
      <header
        className="sticky top-0 z-30 border-b border-hairline bg-bone flex items-center justify-between px-4 pb-3"
        style={{
          paddingTop:
            "calc(env(safe-area-inset-top, 0px) + 0.75rem)",
        }}
      >
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

      {/* Push opt-in banner — disappears once subscribed or on
          unsupported browsers. Sits under the header so it's the
          first thing the mesero sees on a fresh install. */}
      <PushSetup />

      {/* Content area. Pads enough room for the fixed bottom nav PLUS
          the iOS home-indicator strip (~34px on notched iPhones).
          Without the safe-area piece the last row of the page would
          sit under the home indicator on installed PWAs. */}
      <main
        className="flex-1"
        style={{
          paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 6rem)",
        }}
      >
        {children}
      </main>

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
