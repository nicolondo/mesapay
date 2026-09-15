/**
 * Reglas PURAS del tablero de preparación (KDS): cómo cambia un ítem de
 * estado y cómo se deriva el estado de la ronda a partir de sus ítems.
 *
 * Viven separadas de la ruta del tablero porque las usan DOS caminos: el
 * PATCH de /api/operator/order-items/[id] (alguien toca "Empezar" en el
 * tablero) y el marchado automático (la ronda llega y la estación está
 * configurada para marchar sola — ver ./autoFire.ts). Si una regla cambia,
 * cambia para los dos; duplicarla dejaría al marchado automático con la
 * regla vieja la próxima vez que alguien arregle algo en el tablero.
 */

export type KitchenStatus = "placed" | "in_kitchen" | "ready";

export type ItemKitchenStatusData = {
  kitchenStatus: KitchenStatus;
  preparationStartedAt?: Date | null;
};

/**
 * Datos a escribir en el ítem al pasarlo a `next`. La primera entrada a
 * "in_kitchen" arranca el cronómetro (`preparationStartedAt`), que es lo
 * que alimenta la cuenta regresiva del bar; volver a "placed" lo borra, y
 * la siguiente entrada lo vuelve a arrancar. Pasar a "ready" no lo toca.
 */
export function itemKitchenStatusData(
  current: { preparationStartedAt: Date | null },
  next: KitchenStatus,
  now: Date,
): ItemKitchenStatusData {
  const data: ItemKitchenStatusData = { kitchenStatus: next };
  if (next === "in_kitchen" && current.preparationStartedAt == null) {
    data.preparationStartedAt = now;
  }
  if (next === "placed") {
    data.preparationStartedAt = null;
  }
  return data;
}

/**
 * Estado de la ronda = el eslabón más débil de sus ítems vivos:
 *   - alguno "placed"                      → placed
 *   - alguno "in_kitchen" (ninguno placed) → in_kitchen
 *   - todos "ready"                        → ready
 * Quien llama ya excluyó los cancelados: un ítem cancelado no debe dejar
 * la ronda pegada en "placed" cuando el resto ya está en cocina.
 */
export function deriveRoundStatus(
  itemStatuses: readonly KitchenStatus[],
): KitchenStatus {
  if (itemStatuses.some((s) => s === "placed")) return "placed";
  if (itemStatuses.some((s) => s === "in_kitchen")) return "in_kitchen";
  return "ready";
}

export type RoundStatusData = {
  status: KitchenStatus;
  kitchenStartedAt?: Date;
  readyAt?: Date | null;
};

/**
 * Datos a escribir en la ronda para dejarla en `status`:
 *   - la primera vez que entra a "in_kitchen" sella `kitchenStartedAt`
 *     (las ETAs restan el tiempo ya cocinado; no se re-sella después);
 *   - la primera vez que queda "ready" sella `readyAt` y lo avisa con
 *     `becameReady`, para que quien llama le mande el push al mesero;
 *   - si alguien devuelve un ítem desde "ready", la ronda deja de estar
 *     lista y `readyAt` se limpia.
 */
export function roundStatusData(
  round: { kitchenStartedAt: Date | null; readyAt: Date | null },
  status: KitchenStatus,
  now: Date,
): { data: RoundStatusData; becameReady: boolean } {
  const data: RoundStatusData = { status };
  let becameReady = false;
  if (status === "in_kitchen" && !round.kitchenStartedAt) {
    data.kitchenStartedAt = now;
  }
  if (status === "ready" && !round.readyAt) {
    data.readyAt = now;
    becameReady = true;
  }
  if (status !== "ready" && round.readyAt) {
    data.readyAt = null;
  }
  return { data, becameReady };
}
