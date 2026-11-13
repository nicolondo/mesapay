// Qué pide recontar el conteo definitivo — LÓGICA PURA, compartida por la
// API (al iniciar el definitivo) y por la hoja del conteo (para agrupar).
//
// Regla: el definitivo solo pide recontar lo que lo necesita. Un insumo queda
// «confirmado del preliminar» (se arrastra su primer conteo) si se contó, su
// cantidad cuadró con la existencia esperada y su inventario no se movió
// desde que se abrió el conteo. Todo lo demás arranca vacío.

/** Por qué un insumo hay que recontarlo (puede tener más de un motivo). */
export type RecountReason =
  /** El primer conteo no cuadró con la existencia esperada. */
  | "difference"
  /** No se contó en el primer conteo (o entró al conteo después). */
  | "uncounted"
  /** Hubo ventas, compras, producción o ajustes desde que se abrió el conteo. */
  | "moved";

export const RECOUNT_REASONS: readonly RecountReason[] = ["difference", "uncounted", "moved"];

/**
 * Motivos para recontar un insumo al iniciar el conteo definitivo. Lista
 * vacía = confirmado: se arrastra el primer conteo y su ajuste será cero.
 *
 * `liveQty` es la existencia en ese momento y `movedSince`, si tiene algún
 * movimiento desde que se abrió el conteo. Las dos cosas cuentan como
 * «movido»: un saldo distinto es un movimiento neto, y un saldo igual tras
 * una venta y una compra también cambió lo que debería haber en la bodega.
 */
export function recountReasons(
  item: { preliminaryQty: number | null; expectedQty: number },
  live: { liveQty: number; movedSince: boolean },
): RecountReason[] {
  const reasons: RecountReason[] = [];
  if (item.preliminaryQty === null) reasons.push("uncounted");
  else if (item.preliminaryQty !== item.expectedQty) reasons.push("difference");
  if (live.movedSince || live.liveQty !== item.expectedQty) reasons.push("moved");
  return reasons;
}

/**
 * El plan vive dentro de `StockCount.recountSnapshot` (JSON), junto al
 * snapshot de inventario: `recount` trae los motivos por insumo y `full`
 * dice que se pidió «Recontar todo».
 */
export type RecountPlan = {
  /** ingredientId → motivos. Un insumo que no aparece quedó confirmado. */
  reasons: Record<string, RecountReason[]>;
  /** Se pidió recontar todo: nada quedó confirmado del preliminar. */
  full: boolean;
};

/** Lee el plan de un snapshot guardado; null en conteos sin plan (viejos o aún sin definitivo). */
export function parseRecountPlan(snapshot: unknown): RecountPlan | null {
  const value = snapshot as { recount?: unknown; full?: unknown } | null;
  if (!value || typeof value !== "object" || !value.recount || typeof value.recount !== "object" || Array.isArray(value.recount)) return null;
  const reasons: Record<string, RecountReason[]> = {};
  for (const [id, list] of Object.entries(value.recount as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const valid = RECOUNT_REASONS.filter((reason) => list.includes(reason));
    if (valid.length) reasons[id] = valid;
  }
  return { reasons, full: value.full === true };
}

export type RecountStatus = "recount" | "confirmed";

/**
 * ¿Este insumo hay que recontarlo o quedó confirmado? Sin plan (conteo
 * iniciado antes de esta regla) todo se recuenta, como siempre.
 */
export function recountStatus(plan: RecountPlan | null, ingredientId: string): RecountStatus {
  if (!plan || plan.full) return "recount";
  return plan.reasons[ingredientId]?.length ? "recount" : "confirmed";
}

/** Cuántos insumos tienen cada motivo y cuántos quedaron confirmados. */
export function recountSummary(plan: RecountPlan | null, ingredientIds: readonly string[]): Record<RecountReason, number> & { confirmed: number; recount: number } {
  const summary = { difference: 0, uncounted: 0, moved: 0, confirmed: 0, recount: 0 };
  for (const id of ingredientIds) {
    if (recountStatus(plan, id) === "confirmed") { summary.confirmed++; continue; }
    summary.recount++;
    for (const reason of plan?.reasons[id] ?? []) summary[reason]++;
  }
  return summary;
}
