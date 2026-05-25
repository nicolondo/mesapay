import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";

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
      <header className="px-4 py-2 border-b border-hairline bg-bone flex items-center justify-between">
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
