// COP (Colombian peso) formatting — no decimals, . as thousand separator
export function fmtCOP(cents: number): string {
  const pesos = Math.round(cents / 100);
  return "$" + pesos.toLocaleString("es-CO", { maximumFractionDigits: 0 });
}

export function fmtCOPlong(cents: number): string {
  const pesos = Math.round(cents / 100);
  return "$" + pesos.toLocaleString("es-CO") + " COP";
}

export function pesosToCents(pesos: number): number {
  return Math.round(pesos * 100);
}
