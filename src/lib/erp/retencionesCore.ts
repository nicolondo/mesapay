// Motor PURO de retenciones (retefuente / reteIVA / reteICA): sin BD, así
// lo importan el server (compras, gastos, cron de recurrentes) y el
// formulario de gastos en el cliente — la sugerencia en pantalla y la que
// recalcula el servidor salen de la MISMA función. La siembra y la
// configuración (que sí usan la BD) viven en retenciones.ts.

/** UVT 2026 = $52.374 (Res. DIAN 000238/2025), en centavos. */
export const UVT_DEFAULT_CENTS = 5_237_400;

export type RetentionKind = "retefuente" | "reteiva" | "reteica";

export type RetentionConceptInput = {
  id: string;
  kind: RetentionKind | string;
  name: string;
  rateBps: number;
  base: "subtotal" | "tax" | string;
  thresholdUvt: number;
  accountCode: string;
};

export type RetentionLine = {
  conceptId: string;
  kind: string;
  name: string;
  accountCode: string;
  amountCents: number;
};

export type RetentionResult = {
  lines: RetentionLine[];
  /** Totales mapeados a los campos que ya llevan las compras de MESAPAY. */
  retefuenteCents: number;
  reteIvaCents: number;
  reteIcaCents: number;
  totalCents: number;
};

/**
 * Retenciones de un documento de COMPRA según los conceptos ACTIVOS: por
 * concepto, la base es el subtotal o el impuesto; si la base alcanza el
 * umbral (thresholdUvt × uvtCents; 0 = siempre), retiene rateBps/10000 de
 * la base, redondeado al centavo. Puro — testeable sin BD.
 */
export function computeRetentions(
  concepts: RetentionConceptInput[],
  doc: { subtotalCents: number; taxCents: number },
  uvtCents: number,
): RetentionResult {
  const lines: RetentionLine[] = [];
  let retefuente = 0;
  let reteIva = 0;
  let reteIca = 0;
  for (const c of concepts) {
    const baseCents = c.base === "tax" ? doc.taxCents : doc.subtotalCents;
    if (baseCents <= 0) continue;
    const thresholdCents = c.thresholdUvt * uvtCents;
    if (thresholdCents > 0 && doc.subtotalCents < thresholdCents) continue;
    const amountCents = Math.round((baseCents * c.rateBps) / 10_000);
    if (amountCents <= 0) continue;
    lines.push({
      conceptId: c.id,
      kind: c.kind,
      name: c.name,
      accountCode: c.accountCode,
      amountCents,
    });
    if (c.kind === "reteiva") reteIva += amountCents;
    else if (c.kind === "reteica") reteIca += amountCents;
    else retefuente += amountCents;
  }
  return {
    lines,
    retefuenteCents: retefuente,
    reteIvaCents: reteIva,
    reteIcaCents: reteIca,
    totalCents: retefuente + reteIva + reteIca,
  };
}
