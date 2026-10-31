"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";

/**
 * Resumen de la emisión automática del comercio (ver
 * `lib/dian/pendingEmission.ts`).
 */
export type EmissionInfo = {
  waiting: number;
  blockedBy: string | null;
  blockedCount: number;
  numbersLeft: number | null;
};

/** Desde cuántos números restantes se avisa (= NUMBERS_LEFT_WARNING). */
const NUMBERS_LEFT_WARNING = 500;

/** Motivos de bloqueo con texto propio; cualquier otro se muestra crudo. */
const BLOCK_REASONS = new Set([
  "no_config",
  "no_certificate",
  "missing_credentials",
  "master_key_missing",
  "decrypt_failed",
  "no_emisor",
  "resolution_incomplete",
  "location_incomplete",
  "contact_email_incomplete",
  "numbering_exhausted",
  "number_out_of_range",
  "no_lines",
]);

/**
 * Motivo de bloqueo (o de rechazo) → texto. Los códigos conocidos tienen
 * traducción en `opFacturas.blockReason_*`; el resto (las reglas que
 * devuelve la DIAN, en su propio texto) se muestra tal cual.
 */
export function blockReasonText(
  code: string,
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  return BLOCK_REASONS.has(code) ? t(`blockReason_${code}`) : code;
}

/**
 * Aviso de la emisión automática. Rojo cuando algo del COMERCIO frena las
 * facturas (configuración incompleta, rango agotado): con emisión
 * automática eso deja TODA la facturación parada sin que nadie apriete
 * nada. Amarillo cuando la resolución se está quedando sin números.
 */
export function EmissionBanner({ emission }: { emission: EmissionInfo }) {
  const t = useTranslations("opFacturas");
  const exhausted = emission.numbersLeft === 0;
  const lowNumbers =
    emission.numbersLeft != null && emission.numbersLeft < NUMBERS_LEFT_WARNING;
  const blocked = emission.blockedCount > 0 && emission.blockedBy;
  const queued = emission.waiting - emission.blockedCount;
  if (!blocked && !lowNumbers && queued <= 0) return null;
  return (
    <div className="space-y-2 mb-6">
      {blocked && (
        <div className="rounded-2xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
          <div className="font-medium">
            {t("emissionBlocked", {
              count: emission.blockedCount,
              reason: blockReasonText(emission.blockedBy!, t),
            })}
          </div>
          <p className="mt-1 text-[12px] opacity-90">{t("emissionBlockedHint")}</p>
          <Link
            href="/operator/settings/facturacion-dian"
            className="inline-block mt-2 text-[12px] font-medium underline"
          >
            {t("emissionBlockedCta")}
          </Link>
        </div>
      )}
      {lowNumbers && (
        <div
          className={
            "rounded-2xl border p-4 text-sm " +
            (exhausted
              ? "border-danger/30 bg-danger/10 text-danger"
              : "border-[#C98A2E]/40 bg-[#C98A2E]/15 text-[#7F5A1F]")
          }
        >
          {exhausted
            ? t("numbersExhausted")
            : t("numbersLeftWarning", { count: emission.numbersLeft! })}
        </div>
      )}
      {queued > 0 && (
        <p className="text-[12px] text-op-muted px-1">
          {t("emissionWaiting", { count: queued })}
        </p>
      )}
    </div>
  );
}
