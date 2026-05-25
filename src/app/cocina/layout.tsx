import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";

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
      <header className="px-4 py-2 border-b border-hairline bg-bone flex items-center justify-between">
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
