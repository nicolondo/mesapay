import { Fragment } from "react";
import { useTranslations } from "next-intl";
import { fmtCOP } from "@/lib/format";

/** Una línea «Propina devuelta por anulación (NC…)» (ver lib/creditNoteTipReturns). */
export type TipReturnLineView = { creditNoteId: string; documentNumber: string; cents: number };

/** −$61.830 / $61.830: el signo va adelante, no entre el $ y la cifra. */
export function fmtSignedCOP(cents: number): string {
  return cents < 0 ? `−${fmtCOP(-cents)}` : fmtCOP(cents);
}

/**
 * Propinas cobradas − propinas devueltas por anulación = propinas netas del
 * equipo, con una línea negativa por nota. Sin devoluciones no pinta nada.
 * Si las netas quedan en negativo (la propina ya se le había entregado al
 * equipo) lo dice, en vez de esconderlo. Sirve en Server y Client Components.
 */
export function TipReturnsBox({
  lines,
  collectedCents,
  className = "",
}: {
  lines: readonly TipReturnLineView[];
  collectedCents: number;
  className?: string;
}) {
  const t = useTranslations("tipReturns");
  if (lines.length === 0) return null;
  const net = collectedCents - lines.reduce((s, l) => s + l.cents, 0);
  return (
    <div className={`rounded-xl border border-op-border p-3 text-sm ${className}`}>
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1">
        <dt>{t("collected")}</dt>
        <dd className="text-right tabular-nums">{fmtCOP(collectedCents)}</dd>
        {lines.map((l) => (
          <Fragment key={l.creditNoteId}>
            <dt className="min-w-0 break-words">{t("line", { number: l.documentNumber })}</dt>
            <dd className="text-right tabular-nums text-danger">{fmtSignedCOP(-l.cents)}</dd>
          </Fragment>
        ))}
        <dt className="font-semibold">{t("net")}</dt>
        <dd className={`text-right font-semibold tabular-nums ${net < 0 ? "text-danger" : ""}`}>{fmtSignedCOP(net)}</dd>
      </dl>
      {net < 0 && <p className="mt-2 text-xs text-danger">{t("negative")}</p>}
      <p className="mt-2 text-xs text-op-muted">{t("explain")}</p>
    </div>
  );
}
