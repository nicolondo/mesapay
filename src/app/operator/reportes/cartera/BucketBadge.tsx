import { getTranslations } from "next-intl/server";
import { BUCKET_I18N_KEY, type AgingBucket } from "@/lib/erp/reports/cartera";

/**
 * Tramo de antigüedad como etiqueta de color: corriente neutro, 1–30
 * ámbar (`warn` del tema), 31–60 naranja, más de 60 rojo (`danger`). Al
 * imprimir, `ReportShell` fuerza tinta negra y el texto del tramo sigue
 * diciendo cuál es.
 */
const TONE: Record<AgingBucket, string> = {
  corriente: "border border-op-border bg-op-bg text-op-muted",
  "1-30": "bg-warn/10 text-warn",
  "31-60": "bg-orange-100 text-orange-800",
  "60+": "bg-danger/10 text-danger",
};

export async function BucketBadge({ bucket }: { bucket: AgingBucket }) {
  const t = await getTranslations("opCartera");
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONE[bucket]}`}
    >
      {t(BUCKET_I18N_KEY[bucket])}
    </span>
  );
}
