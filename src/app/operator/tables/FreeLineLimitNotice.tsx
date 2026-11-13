"use client";

import { useTranslations } from "next-intl";
import { fmtCOP } from "@/lib/format";
import { maxFreeLineDisplayCents } from "@/lib/freeLineLimit";

/**
 * Aviso del tope de un cargo o servicio, debajo del precio. Sin esto el botón
 * «Agregar a la cuenta» se apagaba sin decir por qué cuando el valor pasaba
 * el máximo de la cuenta. Dice cuánto es el máximo y qué hacer para cobrar
 * más (partir el valor en otra cuenta o factura).
 *
 * Sólo se pinta si el valor de la línea supera el máximo.
 */
export function FreeLineLimitNotice({
  lineCents,
  maxLineCents,
  qty,
}: {
  /** Precio unitario × cantidad, sin el impuesto que se suma encima. */
  lineCents: number;
  /** `maxFreeLineCents` de la cuenta con el impuesto elegido. */
  maxLineCents: number;
  qty: number;
}) {
  const tr = useTranslations("opTables");
  if (lineCents <= maxLineCents) return null;
  const max = fmtCOP(maxFreeLineDisplayCents(maxLineCents));
  return (
    <p role="alert" className="text-xs text-danger -mt-2">
      {qty > 1
        ? tr("freeLineMaxForAccountQty", { max })
        : tr("freeLineMaxForAccount", { max })}{" "}
      {tr("freeLineMaxSplitHint")}
    </p>
  );
}
