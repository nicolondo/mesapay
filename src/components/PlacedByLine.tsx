"use client";

import { useTranslations } from "next-intl";
import { roleLabelKey } from "@/lib/orders/placedBy";

/**
 * "Montó: Juan · Mesero" — quién montó la ronda cuando fue el personal y
 * no el comensal. Lo comparten el KDS de cocina, el tablero del bar, el
 * Salón (entrega) y el detalle de mesa; las etiquetas de rol viven en el
 * namespace `kitchen`. Sin nombre no pinta nada (pedido del comensal). Un
 * rol que ya no existe (snapshot viejo) muestra sólo el nombre.
 */
export function PlacedByLine({
  name,
  role,
  className,
}: {
  name: string | null | undefined;
  role: string | null | undefined;
  className?: string;
}) {
  const tr = useTranslations("kitchen");
  if (!name) return null;
  const key = roleLabelKey(role);
  return (
    <div
      className={
        className ??
        "font-mono text-[11px] tracking-wider uppercase text-op-muted truncate"
      }
    >
      {key
        ? tr("placedBy", { name, role: tr(key) })
        : tr("placedByNoRole", { name })}
    </div>
  );
}
