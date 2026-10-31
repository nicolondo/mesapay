import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { ChangePasswordForm } from "@/components/account/ChangePasswordForm";

export const dynamic = "force-dynamic";

/**
 * "Mi cuenta" del platform_admin: hoy sólo cambiar la contraseña propia
 * (pide la actual). El layout de /admin ya exige role=platform_admin.
 */
export default async function AdminAccountPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin?callbackUrl=/admin/cuenta");
  const t = await getTranslations("myAccount");

  return (
    <div className="p-6 max-w-xl mx-auto w-full">
      <h1 className="font-display text-3xl mb-1">{t("title")}</h1>
      <p className="text-sm text-op-muted mb-6">{t("intro")}</p>

      <section className="rounded-2xl border border-op-border bg-op-surface p-5 mb-6">
        <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
          {t("emailLabel")}
        </div>
        <div className="text-sm font-medium break-all">{session.user.email}</div>
      </section>

      <section
        aria-labelledby="change-password-title"
        className="rounded-2xl border border-op-border bg-op-surface p-5"
      >
        <h2
          id="change-password-title"
          className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-2"
        >
          {t("passwordSection")}
        </h2>
        <p className="text-xs text-op-muted mb-4">{t("passwordIntro")}</p>
        <ChangePasswordForm signInPath="/signin" />
      </section>
    </div>
  );
}
