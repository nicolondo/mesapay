import { redirect } from "next/navigation";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { auth, signOut } from "@/auth";

/**
 * Layout server-gated para /comercial/*.
 * Solo roles `comercial` y `platform_admin` tienen acceso.
 * Diseño minimalista, sin nav compleja — es un portal de solo lectura.
 */
export default async function ComercialLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/signin?callbackUrl=/comercial");

  const { role } = session.user;
  if (role !== "comercial" && role !== "platform_admin") {
    redirect("/");
  }

  const t = await getTranslations("comercialPortal");

  const signOutForm = (
    <form
      action={async () => {
        "use server";
        await signOut({ redirectTo: "/" });
      }}
    >
      <button className="text-terracotta hover:underline text-sm">
        {t("signOut")}
      </button>
    </form>
  );

  return (
    <div className="flex flex-1 flex-col bg-op-bg text-op-text min-h-screen">
      <header className="border-b border-op-border bg-op-surface sticky top-0 z-10">
        <div className="flex items-center justify-between px-4 md:px-6 py-3 gap-3">
          <div className="shrink-0">
            <div className="font-mono text-[9px] tracking-[0.18em] uppercase text-terracotta">
              {t("shellTag")}
            </div>
            <div className="font-display text-xl tracking-[-0.015em]">
              {"MESAPAY"}
            </div>
          </div>
          <div className="flex items-center gap-3 text-sm">
            {role === "platform_admin" && (
              <Link
                href="/admin"
                className="font-mono text-[10px] tracking-wider uppercase text-op-muted hover:text-op-text"
              >
                {"Admin"}
              </Link>
            )}
            <span className="hidden md:inline text-op-muted">
              {session.user.email}
            </span>
            {signOutForm}
          </div>
        </div>
      </header>
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  );
}
