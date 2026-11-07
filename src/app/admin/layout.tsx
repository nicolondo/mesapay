import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth, signOut } from "@/auth";
import { AdminShell } from "./AdminShell";
import { LocaleSwitcher } from "@/components/LocaleSwitcher";
import { Icon } from "@/components/ui/Icon";
import "./admin-workspace.css";
import { FullIntlProvider } from "@/i18n/IntlProviders";

/**
 * Área con sesión del equipo: todo lo que pinta este layout (menús, avisos,
 * banners y la página) recibe el catálogo completo de textos. Ver
 * src/i18n/clientMessages.ts.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Se llama como función (no como <AdminLayoutContent/>) para que redirect() y
  // notFound() sigan saliendo del propio layout, igual que antes.
  return <FullIntlProvider>{await AdminLayoutContent({ children })}</FullIntlProvider>;
}

async function AdminLayoutContent({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/signin?callbackUrl=/admin");
  if (session.user.role !== "platform_admin") redirect("/");
  const t = await getTranslations("opAdmin");

  return (
    <AdminShell
      userEmail={session.user.email ?? ""}
      localeSwitcher={<LocaleSwitcher />}
      signOut={
        <form action={async () => {
          "use server";
          await signOut({ redirectTo: "/" });
        }}>
          <button type="submit" className="mp-admin-signout" aria-label={t("signOutFull")}>
            <Icon name="logout" width="15" height="15" />{t("signOut")}
          </button>
        </form>
      }
    >
      {children}
    </AdminShell>
  );
}

export async function generateMetadata() {
  const t = await getTranslations("adminWorkspace");
  return { title: t("portalName"), robots: { index: false, follow: false } };
}
