import type { ReactNode } from "react";
import { PRINT_AGENT_ARTICLE } from "@/lib/help/constants";
import { PrintAgentDownload } from "./PrintAgentDownload";

/**
 * Piezas que no caben en el markdown de un artículo y las pone el código:
 * hoy, sólo el botón de descarga del agente de impresión (un enlace externo,
 * que el markdown no permite a propósito). Clave: "<categoria>/<slug>".
 *
 * El contenido de la etapa 2 no necesita tocar esto.
 */
const EXTRAS: Record<string, () => ReactNode> = {
  [`${PRINT_AGENT_ARTICLE.category}/${PRINT_AGENT_ARTICLE.slug}`]: () => (
    <div className="rounded-2xl border border-op-border bg-op-surface p-4 sm:p-5">
      <PrintAgentDownload />
    </div>
  ),
};

export function articleExtra(categoryId: string, slug: string): ReactNode {
  return EXTRAS[`${categoryId}/${slug}`]?.() ?? null;
}
