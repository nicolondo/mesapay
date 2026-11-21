"use client";

import { useEffect, useState } from "react";
import { liveLinesSignature, type CancelledItemView } from "@/lib/orders/cancelledItems";
import { CancelledItemsDisclosure } from "./CancelledItemsDisclosure";

/**
 * «Platos cancelados» dentro de la ficha de la mesa (`TableDetailSheet`).
 * Trae la lista de su propio endpoint para que la ficha sólo tenga que
 * montarlo, y la vuelve a pedir cuando cambian los platos vivos que la ficha
 * ya refresca: un plato sólo se cancela saliendo de ahí.
 */
export function LiveCancelledItems({
  orderId,
  liveRounds,
  liveFreeLines,
}: {
  orderId: string;
  liveRounds: { id: string; status: string; items: { id: string }[] }[];
  liveFreeLines: { id: string }[];
}) {
  const signature = liveLinesSignature(liveRounds, liveFreeLines);
  const [data, setData] = useState<{ currency: string; items: CancelledItemView[] } | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/operator/orders/${orderId}/cancelled-items`);
        if (!res.ok) return;
        const json = (await res.json()) as { currency: string; items: CancelledItemView[] };
        if (alive) setData(json);
      } catch {
        // Sin red: queda lo último que se trajo; el próximo cambio reintenta.
      }
    })();
    return () => {
      alive = false;
    };
  }, [orderId, signature]);

  if (!data) return null;
  return <CancelledItemsDisclosure items={data.items} currency={data.currency} />;
}
