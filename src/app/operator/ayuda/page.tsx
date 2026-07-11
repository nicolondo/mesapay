import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

/**
 * Ayuda / soporte del operador: guías rápidas de cómo usar la plataforma +
 * contacto con soporte técnico. Página estática (sin datos del comercio) —
 * el gate del layout /operator ya exige sesión de operador.
 */
export default async function AyudaPage() {
  const t = await getTranslations("opErp");

  // Guías: cada una es un título + una descripción corta. El contenido vive
  // en i18n (opErp.helpGuide*). Mantener conciso — es un mapa, no un manual.
  const guides: Array<{ title: string; body: string }> = [
    { title: t("helpGuideOrdersTitle"), body: t("helpGuideOrdersBody") },
    { title: t("helpGuideChargeTitle"), body: t("helpGuideChargeBody") },
    { title: t("helpGuideCloseTitle"), body: t("helpGuideCloseBody") },
    { title: t("helpGuidePurchasesTitle"), body: t("helpGuidePurchasesBody") },
    { title: t("helpGuideInventoryTitle"), body: t("helpGuideInventoryBody") },
    { title: t("helpGuideAccountingTitle"), body: t("helpGuideAccountingBody") },
  ];

  const supportEmail = "soporte@mesapay.co";

  return (
    <div className="p-6 max-w-3xl mx-auto w-full">
      <div className="font-display text-3xl mb-1">{t("helpTitle")}</div>
      <p className="text-sm text-op-muted mb-6">{t("helpIntro")}</p>

      {/* Contacto con soporte */}
      <div className="rounded-2xl border border-op-border bg-op-surface p-5 mb-6">
        <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1">
          {t("helpSupportKicker")}
        </div>
        <h2 className="font-display text-lg mb-1">{t("helpSupportTitle")}</h2>
        <p className="text-sm text-op-muted mb-3">{t("helpSupportBody")}</p>
        <a
          href={`mailto:${supportEmail}`}
          className="inline-flex items-center justify-center min-h-[44px] px-5 rounded-full bg-ink text-bone text-sm font-medium hover:bg-ink/90"
        >
          {t("helpSupportEmailCta")}
        </a>
        <p className="text-[11px] text-op-muted mt-2">{supportEmail}</p>
      </div>

      {/* Guías rápidas */}
      <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-2">
        {t("helpGuidesKicker")}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {guides.map((g) => (
          <div
            key={g.title}
            className="rounded-2xl border border-op-border bg-op-surface p-4"
          >
            <h3 className="font-medium mb-1">{g.title}</h3>
            <p className="text-sm text-op-muted">{g.body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
