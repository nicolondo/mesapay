import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { redirect } from "next/navigation";

const CRM_ROLES = new Set(["comercial", "gerente_comercial", "platform_admin"]);

export default async function CalendarioPage() {
  const session = await auth();
  if (!session?.user || !CRM_ROLES.has(session.user.role ?? "")) {
    redirect("/signin?callbackUrl=/comercial/calendario");
  }

  const t = await getTranslations("crm");

  return (
    <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
      <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-2">
        {"CRM"}
      </div>
      <div className="font-display text-2xl mb-2">{t("calendarTitle")}</div>
      <p className="text-sm text-op-muted">{t("comingSoon")}</p>
    </div>
  );
}
