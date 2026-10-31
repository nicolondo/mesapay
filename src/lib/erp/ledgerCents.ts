/**
 * Montos contables guardados en BIGINT → centavos `number`.
 *
 * Un INT4 sólo llega a 2.147.483.647 centavos ($21.474.836,47): el
 * asiento-resumen MENSUAL de ventas de un comercio mediano lo pasa de largo.
 * Por eso son BIGINT las líneas de asiento (JournalLine.debitCents /
 * creditCents) y los montos contables que las alimentan (FixedAsset,
 * DeferredItem, Budget, TaxFiling, BankStatementLine).
 *
 * Prisma devuelve esas columnas como `bigint` de JS (y `SUM` de un BIGINT en
 * SQL crudo es NUMERIC: las consultas lo castean `::bigint`). El resto de la
 * app —cálculos, JSON, props de Server → Client Components— trabaja con
 * centavos `number`, y `JSON.stringify` revienta con un `bigint`. Se convierte
 * en el punto de lectura, antes de sumar o serializar. Un `number` es exacto
 * hasta 2^53 (~$90 billones en centavos): lo que no quepa se rechaza en vez de
 * redondearse en silencio; la migración pone el mismo rango como CHECK.
 */
export type StoredCents = number | bigint;

export function centsToNumber(value: StoredCents): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount)) throw new RangeError("ledger_amount_out_of_range");
  return amount;
}

type LineCents = { debitCents: StoredCents; creditCents: StoredCents };

export type NumericLineCents<T extends LineCents> = Omit<T, keyof LineCents> & {
  debitCents: number;
  creditCents: number;
};

/** Una línea de asiento con débito y crédito en `number` (no muta la original). */
export function lineCentsToNumbers<T extends LineCents>(line: T): NumericLineCents<T> {
  return {
    ...line,
    debitCents: centsToNumber(line.debitCents),
    creditCents: centsToNumber(line.creditCents),
  };
}
