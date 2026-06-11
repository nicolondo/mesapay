import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { auth, signOut } from "@/auth";
import { redirect } from "next/navigation";
import { MasImportSection } from "./MasImportSection";

const CRM_ROLES = new Set(["comercial", "gerente_comercial", "platform_admin"]);

export const dynamic = "force-dynamic";

export default async function MasPage() {
  const session = await auth();
  if (!session?.user || !CRM_ROLES.has(session.user.role ?? "")) {
    redirect("/signin?callbackUrl=/comercial/mas");
  }
  const { role } = session.user;

  const t = await getTranslations("crm");

  const signOutAction = async () => {
    "use server";
    await signOut({ redirectTo: "/" });
  };

  return (
    <div className="flex-1 p-4 max-w-2xl mx-auto w-full">
      <div className="font-display text-2xl tracking-[-0.015em] mb-6">
        {t("masTitle")}
      </div>

      {/* Links list */}
      <div className="rounded-2xl border border-op-border bg-op-surface divide-y divide-op-border mb-6">
        <MasLink href="/comercial" label={t("masCommissions")} />
        {(role === "gerente_comercial" || role === "platform_admin") && (
          <MasLink href="/comercial/equipo" label={t("masTeam")} />
        )}
        <MasLink href="/comercial/mas/documentos" label={t("masDocs")} />
        <MasLink href="/comercial/mas/correo" label={t("masEmail")} />
        <MasLink href="/comercial/mas/plantillas" label={t("masTemplates")} />
        <MasLink href="/comercial/mas/perfil" label={t("masProfile")} />
      </div>

      {/* Export CSV */}
      <a
        href="/api/crm/leads/export"
        download
        className="flex items-center justify-between w-full px-4 py-4 rounded-2xl border border-op-border bg-op-surface min-h-[44px] hover:bg-op-bg transition-colors mb-4"
      >
        <span className="text-sm font-medium">{t("exportLeads")}</span>
        <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-op-muted">
          <path fillRule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clipRule="evenodd" />
        </svg>
      </a>

      {/* Import CSV section */}
      <MasImportSection />

      {/* Sign out */}
      <form action={signOutAction} className="mt-8">
        <button
          type="submit"
          className="w-full text-center text-sm text-terracotta hover:underline py-3"
        >
          {t("masSignOut")}
        </button>
      </form>
    </div>
  );
}

function MasLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="flex items-center justify-between px-4 py-4 min-h-[44px] hover:bg-op-bg transition-colors"
    >
      <span className="text-sm font-medium">{label}</span>
      <svg
        viewBox="0 0 20 20"
        fill="currentColor"
        className="w-4 h-4 text-op-muted"
      >
        <path
          fillRule="evenodd"
          d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
          clipRule="evenodd"
        />
      </svg>
    </Link>
  );
}
