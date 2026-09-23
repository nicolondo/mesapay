/**
 * Presentación del código de una cuenta (`Order.shortCode`).
 *
 * El código completo (`002A77-77C496-58E6EF-6C25C8`, 96 bits aleatorios)
 * es largo A PROPÓSITO: es lo que impide adivinar una cuenta ajena, y sigue
 * siendo EL identificador en la base, las URLs, los tokens, los webhooks y
 * las búsquedas. Pero un humano sólo necesita el primer grupo (`002A77`)
 * para referirse a la cuenta en la mesa, la cocina o la caja, así que en
 * pantalla, tirillas, comandas y correos va corto. Donde el elemento lo
 * admite, el código completo viaja en `title=` para soporte.
 *
 * Vive en un módulo aparte de `shortCode.ts` (que usa `node:crypto`) para
 * poder importarse desde componentes cliente sin arrastrar Node al bundle.
 */
export function displayOrderCode(code: string | null | undefined): string {
  if (!code) return "";
  const trimmed = code.trim();
  const dash = trimmed.indexOf("-");
  return dash >= 0 ? trimmed.slice(0, dash) : trimmed.slice(0, 6);
}
