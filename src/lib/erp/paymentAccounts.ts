// Cuentas de dinero (caja, bancos, pasarela) desde las que sale un pago.
// Compartido por los abonos a proveedores (compras) y el asiento que los
// cancela contra la CxP (posting.ts).
import { loadChartOfAccounts } from "./ledger";

/** Prefijo del PUC de "Efectivo y equivalentes": caja, bancos, pasarelas. */
export const MONEY_ACCOUNT_PREFIX = "11";

/** ¿El código es una cuenta de dinero (caja/banco/pasarela)? */
export function isMoneyAccountCode(code: string): boolean {
  return code.startsWith(MONEY_ACCOUNT_PREFIX);
}

/**
 * Cuentas de dinero POSTABLES del plan del comercio, ordenadas por código.
 * Siembra el plan si todavía no existe (loadChartOfAccounts lo garantiza),
 * así la pantalla de compras no depende de que el módulo contable se haya
 * abierto alguna vez.
 */
export async function listMoneyAccounts(
  restaurantId: string,
): Promise<{ code: string; name: string }[]> {
  const chart = await loadChartOfAccounts(restaurantId);
  return chart
    .filter((a) => a.postable && isMoneyAccountCode(a.code))
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((a) => ({ code: a.code, name: a.name }));
}

const BANK_METHOD_RE =
  /transf|banc|nequi|daviplata|pse|tarjeta|d[eé]bito|cr[eé]dito|bre-?b|consignaci/i;

/**
 * Heurística SOLO para abonos anteriores a que existiera `accountCode`:
 * un mejor esfuerzo para no dejar la cuenta por pagar sin cancelar en los
 * meses abiertos. Si el texto libre del método suena a banco (transferencia,
 * Nequi, tarjeta, consignación…) cae en bancos (111005); si no, en caja
 * general (110505). Los abonos nuevos siempre traen la cuenta que eligió el
 * operador y no pasan por acá.
 */
export function legacyPurchasePaymentAccount(
  method: string | null | undefined,
): string {
  if (method && BANK_METHOD_RE.test(method)) return "111005";
  return "110505";
}

/** Cuenta de origen de un abono: la elegida, o la heurística para los viejos. */
export function resolvePurchasePaymentAccount(p: {
  accountCode: string | null;
  method: string | null;
}): string {
  return p.accountCode ?? legacyPurchasePaymentAccount(p.method);
}
