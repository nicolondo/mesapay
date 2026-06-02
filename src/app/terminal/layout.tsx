import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth, signOut } from "@/auth";
import { db } from "@/lib/db";
import { getActiveContext } from "@/lib/activeRestaurant";

/**
 * Layout for the datáfono operator surface. Roles allowed:
 *   - terminal (the dedicated POS user)
 *   - operator (so the owner can preview / cover for them)
 *   - platform_admin (for support)
 */
export default async function TerminalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const t = await getTranslations("opTerminal");
  const session = await auth();
  if (!session?.user) redirect("/signin?callbackUrl=/terminal");
  const role = session.user.role;
  if (role !== "terminal" && role !== "operator" && role !== "platform_admin") {
    redirect("/");
  }

  const ctx = await getActiveContext();
  const restaurantId = ctx?.restaurantId ?? session.user.restaurantId ?? null;
  if (!restaurantId) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-bone">
        <div className="text-center max-w-sm">
          <div className="font-display text-2xl">
            {t("noRestaurantAssignedTitle")}
          </div>
          <p className="text-muted mt-2 text-sm">
            {t("noRestaurantAssignedBody")}
          </p>
        </div>
      </div>
    );
  }
  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { name: true },
  });

  return (
    <div className="min-h-screen flex flex-col bg-ink text-bone">
      <header className="border-b border-bone/10 px-5 py-3 flex items-center justify-between">
        <div>
          <div className="font-mono text-[9px] tracking-[0.18em] uppercase opacity-60">
            {t("headerLabel", { name: tenant?.name ?? "—" })}
          </div>
          <div className="font-display text-xl">{"MESAPAY"}</div>
        </div>
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/" });
          }}
        >
          <button className="text-bone/70 text-sm hover:underline">
            {t("signOut")}
          </button>
        </form>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
