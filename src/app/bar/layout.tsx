import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";

/** Ver `src/app/mesero/layout.tsx` para el racional. */
export const metadata: Metadata = {
  title: "MP BAR",
  applicationName: "MP BAR",
  manifest: "/api/manifest/bar",
  appleWebApp: {
    capable: true,
    title: "MP BAR",
    statusBarStyle: "black-translucent",
  },
};

/**
 * Bar-only layout — same single-purpose pattern as /cocina. Drops the
 * top nav; the bartender lands here and stays here. Allowed roles:
 * bar (primary), operator + platform_admin for ops + dogfooding.
 */
export default async function BarLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/signin?callbackUrl=/bar");
  const role = session.user.role;
  if (
    role !== "bar" &&
    role !== "operator" &&
    role !== "platform_admin"
  ) {
    redirect("/");
  }

  return (
    <div className="min-h-screen bg-paper">
      {/* Same safe-area pattern as the mesero / cocina layouts. */}
      <header
        className="staff-safe-top sticky top-0 z-30 border-b border-hairline bg-bone flex items-center justify-between px-4 pb-2"
        style={
          // Ver `src/app/mesero/layout.tsx` para el racional.
          { "--staff-safe-base-pt": "0.5rem" } as React.CSSProperties
        }
      >
        <div className="font-display text-lg">Bar</div>
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
