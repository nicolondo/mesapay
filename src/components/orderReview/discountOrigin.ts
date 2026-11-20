import type { DiscountOriginView } from "@/lib/orderReview";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * «Descuento del cliente ACME 20 %» / «Descuento del comensal Ana 10 %»
 * (namespace `discountOrigin`). null cuando no se sabe de dónde viene
 * (cuentas anteriores a la columna de origen): quien llama muestra su
 * texto genérico de siempre.
 */
export function discountOriginLabel(
  origin: DiscountOriginView | undefined,
  pct: number | null | undefined,
  t: Translate,
): string | null {
  if (!origin) return null;
  const key = origin.kind === "customer" ? "customer" : "diner";
  return pct ? t(key, { name: origin.name, pct }) : t(`${key}NoPct`, { name: origin.name });
}
