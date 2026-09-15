import type { ReactNode } from "react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

/**
 * Descarga del agente de impresión. El .exe NO vive en el repo: se publica
 * como adjunto de un GitHub Release (`print-agent-vX.Y.Z`, lo arma el
 * workflow print-agent-release.yml). `releases/latest` resuelve solo a la
 * release más nueva, así el botón no queda apuntando a una versión vieja
 * cuando salga la siguiente. El repo es público: la descarga es libre.
 */
const PRINT_AGENT_DOWNLOAD_URL =
  "https://github.com/nicolondo/mesapay/releases/latest/download/mesapay-print-agent.exe";
const PRINT_AGENT_SHA256_URL = `${PRINT_AGENT_DOWNLOAD_URL}.sha256`;

/** Un comando o ruta en línea, dentro de una frase. */
const CODE =
  "font-mono text-xs bg-op-bg border border-op-border px-1.5 py-0.5 rounded";
/** Un bloque de comandos para escribir tal cual. */
const PRE =
  "font-mono text-xs bg-op-bg border border-op-border rounded-lg px-3 py-2 overflow-x-auto whitespace-pre";

/**
 * Ayuda / soporte del operador: guías rápidas de cómo usar la plataforma +
 * contacto con soporte técnico + descarga e instalación del agente de
 * impresión. Página estática (sin datos del comercio) — el gate del layout
 * /operator ya exige sesión de operador.
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

  // Instalación del agente de impresión, condensada de agent/README.md para
  // alguien parado en una cocina. Los literales en <code>/<pre> son rutas y
  // comandos de Windows: se escriben igual en cualquier idioma, por eso van
  // como {"..."} y no por t() — el lint de i18n (jsx-text-only) sólo reclama
  // texto suelto, no expresiones.
  const printerSteps: Array<{ title: string; body: ReactNode }> = [
    {
      title: t("helpPrintersStep1Title"),
      body: (
        <>
          <p>{t("helpPrintersStep1Body")}</p>
          <pre className={PRE}>
            {"C:\\Program Files\\MESAPAY\\mesapay-print-agent.exe"}
          </pre>
          <p>{t("helpPrintersStep1Warn")}</p>
        </>
      ),
    },
    {
      title: t("helpPrintersStep2Title"),
      body: (
        <>
          <p>{t("helpPrintersStep2Body")}</p>
          <pre className={PRE}>
            {'cd "C:\\Program Files\\MESAPAY"\n'}
            {"mesapay-print-agent.exe install\n"}
            {"mesapay-print-agent.exe start"}
          </pre>
          <p>{t("helpPrintersStep2Check")}</p>
          <pre className={PRE}>{"sc.exe query MesapayPrintAgent"}</pre>
          <p>
            {t("helpPrintersStep2CheckPre")}{" "}
            <code className={CODE}>{"STATE : 4 RUNNING"}</code>
            {t("helpPrintersStep2CheckPost")}
          </p>
        </>
      ),
    },
    {
      title: t("helpPrintersStep3Title"),
      body: (
        <>
          <p>
            {t("helpPrintersStep3OpenPre")}{" "}
            <code className={CODE}>{"http://127.0.0.1:9110"}</code>
            {t("helpPrintersStep3OpenPost")}
          </p>
          <p>
            {t("helpPrintersStep3TokenPre")}{" "}
            <Link
              href="/operator/settings/impresoras"
              className="underline hover:text-ink"
            >
              {t("helpPrintersStep3TokenLink")}
            </Link>
            {t("helpPrintersStep3TokenMid")}{" "}
            <code className={CODE}>{"mpa_"}</code>
            {t("helpPrintersStep3TokenPost")}
          </p>
          <p>{t("helpPrintersStep3Paste")}</p>
        </>
      ),
    },
    {
      title: t("helpPrintersStep4Title"),
      body: (
        <>
          <p>{t("helpPrintersStep4Body")}</p>
          <p>{t("helpPrintersStep4Test")}</p>
        </>
      ),
    },
    {
      title: t("helpPrintersStep5Title"),
      body: (
        <>
          <p>{t("helpPrintersStep5Body")}</p>
          <p>{t("helpPrintersStep5Fixed")}</p>
        </>
      ),
    },
    {
      title: t("helpPrintersStep6Title"),
      body: (
        <>
          <p>
            {t("helpPrintersStep6BodyPre")}{" "}
            <code className={CODE}>{"http://127.0.0.1:9110"}</code>{" "}
            {t("helpPrintersStep6BodyPost")}
          </p>
          <ul className="list-disc pl-5 space-y-1">
            <li>{t("helpPrintersStep6NoNet")}</li>
            <li>{t("helpPrintersStep6NoPaper")}</li>
            <li>{t("helpPrintersStep6Zero")}</li>
          </ul>
          <p>
            {t("helpPrintersStep6LogsPre")}{" "}
            <code className={CODE}>
              {"C:\\ProgramData\\MESAPAY\\agent\\logs\\agent.log"}
            </code>
            {t("helpPrintersStep6LogsPost")}
          </p>
        </>
      ),
    },
  ];

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

      {/* Impresoras: descarga + instalación del agente */}
      <section
        id="impresoras"
        className="rounded-2xl border border-op-border bg-op-surface p-5 mb-6 scroll-mt-6"
      >
        <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1">
          {t("helpPrintersKicker")}
        </div>
        <h2 className="font-display text-lg mb-1">{t("helpPrintersTitle")}</h2>
        <p className="text-sm text-op-muted mb-4">{t("helpPrintersBody")}</p>

        <a
          href={PRINT_AGENT_DOWNLOAD_URL}
          download
          rel="noopener"
          className="inline-flex items-center justify-center min-h-[44px] px-5 rounded-full bg-ink text-bone text-sm font-medium hover:bg-ink/90"
        >
          {t("helpPrintersDownloadCta")}
        </a>
        <p className="text-[11px] text-op-muted mt-2">
          {t("helpPrintersDownloadMeta")}
          {" · "}
          <a
            href={PRINT_AGENT_SHA256_URL}
            download
            rel="noopener"
            className="underline hover:text-ink"
          >
            {t("helpPrintersDownloadVerify")}
          </a>
        </p>

        {/* SmartScreen: el binario no está firmado. Es un aviso esperado, no
            un error — por eso va en tono neutro y no en ámbar/rojo. */}
        <div className="mt-4 rounded-xl border border-op-border bg-op-bg p-4">
          <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1">
            {t("helpPrintersSmartScreenKicker")}
          </div>
          <p className="text-sm">{t("helpPrintersSmartScreenBody")}</p>
        </div>

        {/* Pasos plegables: la descarga y el aviso quedan siempre a la vista;
            el detalle sólo si hace falta, para que la ayuda no sea un manual. */}
        <div className="mt-5 font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1">
          {t("helpPrintersStepsKicker")}
        </div>
        <p className="text-[11px] text-op-muted mb-2">
          {t("helpPrintersStepsIntro")}
        </p>
        <ol className="border-y border-op-border divide-y divide-op-border">
          {printerSteps.map((s, i) => (
            <li key={s.title}>
              <details className="group">
                <summary className="flex items-baseline gap-3 py-3 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
                  <span className="font-mono text-[11px] text-op-muted w-5 shrink-0">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="flex-1 text-sm font-medium">{s.title}</span>
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 16 16"
                    className="w-3.5 h-3.5 shrink-0 self-center text-op-muted transition-transform group-open:rotate-90"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M6 3l5 5-5 5" />
                  </svg>
                </summary>
                <div className="pb-4 pl-8 text-sm text-op-muted space-y-2">
                  {s.body}
                </div>
              </details>
            </li>
          ))}
        </ol>

        <Link
          href="/operator/settings/impresoras"
          className="inline-block mt-4 text-sm underline text-op-muted hover:text-ink"
        >
          {t("helpPrintersSettingsLink")}
        </Link>
      </section>

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
