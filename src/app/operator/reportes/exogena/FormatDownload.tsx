"use client";

import { useTranslations } from "next-intl";
import { SplitDownload } from "../_components/SplitDownload";

/**
 * Descarga de un formato de la exógena: botón principal «Descargar Excel»
 * y, pegada, una flechita que despliega «Descargar XML» (botón dividido,
 * `SplitDownload`). El Excel se descarga siempre (con incidencias trae las
 * filas marcadas); con incidencias bloqueantes el XML queda deshabilitado
 * con el motivo. Sin XML (`xml` null, el 2276) no hay flechita.
 */
export function FormatDownload({
  excelHref,
  xml,
}: {
  excelHref: string;
  xml: { href: string; blocked: boolean } | null;
}) {
  const t = useTranslations("opExogena");
  return (
    <SplitDownload
      main={{ href: excelHref, label: t("downloadExcel") }}
      moreLabel={t("downloadMore")}
      items={
        xml
          ? [
              xml.blocked
                ? { label: t("downloadXml"), disabledReason: t("downloadBlocked") }
                : { label: t("downloadXml"), href: xml.href },
            ]
          : []
      }
    />
  );
}
