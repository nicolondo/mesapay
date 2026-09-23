// Propina del comensal — LÓGICA PURA, sin DB ni React.
//
// La misma aritmética la usan dos pantallas: el estado del pedido (que
// PREVISUALIZA el total con propina) y el flujo de pago (que la COBRA). Si
// cada una redondeara por su cuenta, el comensal vería un total acá y otro
// distinto al pagar. Por eso el porcentaje sugerido, el redondeo y la clave
// con la que se recuerda su elección viven en un solo lugar.

/**
 * Porcentajes sugeridos. $0 queda para "sin propina"; 10 % es el default
 * social en Colombia ("la propina del 10"); 15 / 20 cubren "el servicio fue
 * muy bueno".
 */
export const TIP_OPTIONS = [0, 5, 10, 15, 20] as const;

/** Propina preseleccionada cuando el comensal todavía no eligió. */
export const DEFAULT_TIP_PCT = 10;

/**
 * Tope del control deslizante. Permite un valor personalizado por fuera de
 * los chips sin dejar que un dedo torpe deje una propina del 300 %.
 */
export const MAX_TIP_PCT = 30;

/**
 * Interpreta un porcentaje que llega de afuera (query `?tip=`, sessionStorage,
 * un input) y devuelve un ENTERO entre 0 y MAX_TIP_PCT, o null si no es un
 * número usable. Nunca inventa un valor: el que cae al default es el caller.
 */
export function parseTipPct(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return null;
  return clampTipPct(n);
}

/** Entero acotado a 0..MAX_TIP_PCT. Un NaN cae a 0 — nunca a un tope. */
export function clampTipPct(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  return Math.min(MAX_TIP_PCT, Math.max(0, Math.round(pct)));
}

/**
 * Centavos de propina sobre una base. Mismo redondeo que el cobro
 * (`Math.round`): media unidad para arriba, así la previsualización y el
 * pago coinciden centavo a centavo.
 */
export function tipCentsFor(baseCents: number, pct: number): number {
  return Math.round((baseCents * pct) / 100);
}

/** Base + propina — lo que efectivamente sale del bolsillo del comensal. */
export function totalWithTip(baseCents: number, pct: number): number {
  return baseCents + tipCentsFor(baseCents, pct);
}

/**
 * Clave de sessionStorage donde se recuerda el % elegido POR CUENTA: una
 * mesa que paga dos cuentas seguidas no arrastra la propina de una a la
 * otra, y al cerrar la pestaña se olvida.
 */
export function tipStorageKey(orderId: string): string {
  return `mesapay.tip.${orderId}`;
}

/**
 * Agrega `?tip=<pct>` a un href (respetando un query string ya presente)
 * para que el flujo de pago arranque con la propina que el comensal
 * previsualizó en el estado del pedido.
 */
export function hrefWithTip(href: string, pct: number): string {
  const [path, hash = ""] = href.split("#", 2);
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}tip=${clampTipPct(pct)}${hash ? `#${hash}` : ""}`;
}
