/**
 * Códigos de rechazo de Kushki (tarjeta) → motivo traducible por la UI.
 * Las rutas devuelven el código, nunca un texto en un idioma fijo.
 */
export type KushkiDeclineReason =
  | "card_cvv"
  | "card_funds"
  | "card_invalid"
  | "card_blocked"
  | "token_expired"
  | "merchant_config"
  | "charge_failed";

export function kushkiDeclineReason(detail: string): KushkiDeclineReason {
  if (detail.includes('"code":"022"') || detail.includes("(022)")) return "card_cvv";
  if (detail.includes('"code":"021"') || detail.includes("(021)")) return "card_funds";
  if (detail.includes('"code":"017"') || detail.includes("(017)")) return "card_invalid";
  if (detail.includes('"code":"023"') || detail.includes("(023)")) return "card_blocked";
  if (detail.includes('"code":"577"')) return "token_expired";
  if (detail.includes('"code":"K040"')) return "merchant_config";
  return "charge_failed";
}
