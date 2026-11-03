import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import { LandscapeLock } from "@/components/LandscapeLock";
import { FullIntlProvider } from "@/i18n/IntlProviders";

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
 * Área con sesión del equipo: todo lo que pinta este layout (menús, avisos,
 * banners y la página) recibe el catálogo completo de textos. Ver
 * src/i18n/clientMessages.ts.
 */
export default async function BarLayout({ children }: { children: React.ReactNode }) {
  // Se llama como función (no como <BarLayoutContent/>) para que redirect() y
  // notFound() sigan saliendo del propio layout, igual que antes.
  return <FullIntlProvider>{await BarLayoutContent({ children })}</FullIntlProvider>;
}

/**
 * Bar-only layout — same single-purpose pattern as /cocina. Drops the
 * top nav; the bartender lands here and stays here. Allowed roles:
 * bar (primary), operator + platform_admin for ops + dogfooding.
 */
async function BarLayoutContent({
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
      <LandscapeLock />
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
