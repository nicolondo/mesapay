import { getTranslations } from "next-intl/server";
import {
  PRINT_AGENT_DOWNLOAD_URL,
  PRINT_AGENT_SHA256_URL,
} from "@/lib/help/constants";
import { HelpIcon } from "./HelpIcon";

/**
 * Botón de descarga del agente de impresión para Windows, con el enlace para
 * verificar el archivo. Sale en el acceso directo de la portada de la ayuda y
 * arriba del artículo de instalación (cuyo texto remite a este botón; el
 * aviso de Windows al abrirlo está en el artículo).
 */
export async function PrintAgentDownload() {
  const t = await getTranslations("help");
  return (
    <div>
      <a
        href={PRINT_AGENT_DOWNLOAD_URL}
        download
        rel="noopener"
        className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-full bg-ink px-5 text-sm font-medium text-bone hover:bg-ink/90"
      >
        <HelpIcon name="download" className="h-4 w-4" />
        {t("agentDownloadCta")}
      </a>
      <p className="mt-2 text-xs text-op-muted">
        {t("agentDownloadMeta")}
        {" · "}
        <a
          href={PRINT_AGENT_SHA256_URL}
          download
          rel="noopener"
          className="underline hover:text-op-text"
        >
          {t("agentDownloadVerify")}
        </a>
      </p>
    </div>
  );
}
