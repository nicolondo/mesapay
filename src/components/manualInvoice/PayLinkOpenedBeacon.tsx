"use client";

import { useEffect } from "react";

/**
 * Avisa —una vez, desde el navegador del cliente— que abrió el link de pago
 * de una factura manual (la ficha lo muestra como "Abierto"). Sin UI.
 */
export function PayLinkOpenedBeacon({
  slug,
  orderId,
  token,
}: {
  slug: string;
  orderId?: string;
  token?: string;
}) {
  useEffect(() => {
    const body = token ? { token } : orderId ? { orderId } : null;
    if (!body) return;
    void fetch(`/api/tenant/${encodeURIComponent(slug)}/pay-link-opened`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => undefined);
  }, [slug, orderId, token]);
  return null;
}
