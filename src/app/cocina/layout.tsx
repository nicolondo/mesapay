import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import { LandscapeLock } from "@/components/LandscapeLock";

/** Ver `src/app/mesero/layout.tsx` para el racional. */
export const metadata: Metadata = {
  title: "MP COCINA",
  applicationName: "MP COCINA",
  manifest: "/api/manifest/cocina",
  appleWebApp: {
    capable: true,
    title: "MP COCINA",
    statusBarStyle: "black-translucent",
  },
};

/**
 * Cocina-only layout — no top nav, no chrome. The cook opens the app,
 * logs in, and lands directly on the kitchen board. Same role gate as
 * the kitchen page itself: `kitchen` (primary) plus operator /
 * platform_admin for ops + dogfooding.
 */
export default async function CocinaLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/signin?callbackUrl=/cocina");
  const role = session.user.role;
  if (
    role !== "kitchen" &&
    role !== "operator" &&
    role !== "platform_admin"
  ) {
    redirect("/");
  }

  return (
    <div className="min-h-screen bg-paper">
      <LandscapeLock />
      {/* Same safe-area pattern as the mesero layout — pushes the
          header below the iOS status bar so the title doesn't sit
          under the system clock when launched as an installed PWA. */}
      <header
        className="staff-safe-top sticky top-0 z-30 border-b border-hairline bg-bone flex items-center justify-between px-4 pb-2"
        style={
          // Ver `src/app/mesero/layout.tsx` para el racional.
          { "--staff-safe-base-pt": "0.5rem" } as React.CSSProperties
        }
      >
        <div className="font-display text-lg">Cocina</div>
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
      {children}
    </div>
  );
}
