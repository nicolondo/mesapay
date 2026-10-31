/** Constantes del centro de ayuda (sin texto a la vista: eso va por i18n). */

export const SUPPORT_EMAIL = "soporte@mesapay.co";

/**
 * Descarga del agente de impresión. El .exe NO vive en el repo: se publica
 * como adjunto de un GitHub Release (`print-agent-vX.Y.Z`, lo arma el
 * workflow print-agent-release.yml). `releases/latest` resuelve solo a la
 * release más nueva, así el botón no queda apuntando a una versión vieja
 * cuando salga la siguiente. El repo es público: la descarga es libre.
 */
export const PRINT_AGENT_DOWNLOAD_URL =
  "https://github.com/nicolondo/mesapay/releases/latest/download/mesapay-print-agent.exe";
export const PRINT_AGENT_SHA256_URL = `${PRINT_AGENT_DOWNLOAD_URL}.sha256`;

/** Artículo con la guía de instalación del agente (lo enlazan otras pantallas). */
export const PRINT_AGENT_ARTICLE = {
  category: "impresion-y-equipos",
  slug: "instalar-el-agente-de-impresion",
} as const;

export const OPERATOR_HELP_BASE = "/operator/ayuda";
export const MESERO_HELP_BASE = "/mesero/ayuda";

/** `mailto:` a soporte con asunto y cuerpo prellenados. */
export function supportMailto(subject?: string, body?: string): string {
  const params = new URLSearchParams();
  if (subject) params.set("subject", subject);
  if (body) params.set("body", body);
  const qs = params.toString().replace(/\+/g, "%20");
  return `mailto:${SUPPORT_EMAIL}${qs ? `?${qs}` : ""}`;
}
