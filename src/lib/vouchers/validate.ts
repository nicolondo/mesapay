/**
 * ¿Se puede redimir este bono ahora? Función pura: la usa la redención
 * (mesero / comensal) y la vista del lote para pintar el estado real.
 *
 * Orden de las reglas: primero lo que invalida el lote entero, después
 * lo del bono. En prepago el lote tiene que estar PAGADO — la empresa
 * recibió los códigos con el link de pago y hasta que no pague nadie
 * come con ellos.
 */
export type VoucherRedeemability =
  | "ok"
  | "batch_cancelled"
  | "batch_unpaid"
  | "cancelled"
  | "expired"
  | "exhausted";

export type RedeemableVoucher = {
  status: "active" | "exhausted" | "cancelled" | "expired";
  balanceCents: number;
  expiresAt: Date | null;
};

export type RedeemableBatch = {
  mode: "prepaid" | "credit";
  status: "issued" | "paid" | "cancelled";
};

export function voucherRedeemability(
  voucher: RedeemableVoucher,
  batch: RedeemableBatch,
  now: Date = new Date(),
): VoucherRedeemability {
  if (batch.status === "cancelled") return "batch_cancelled";
  if (batch.mode === "prepaid" && batch.status !== "paid") return "batch_unpaid";
  if (voucher.status === "cancelled") return "cancelled";
  if (
    voucher.status === "expired" ||
    (voucher.expiresAt && voucher.expiresAt.getTime() < now.getTime())
  ) {
    return "expired";
  }
  if (voucher.status === "exhausted" || voucher.balanceCents <= 0) {
    return "exhausted";
  }
  return "ok";
}

/**
 * Cuánto se aplica de un bono a lo pendiente de una cuenta: el menor de
 * los dos. Nunca más que el saldo (queda para la próxima) ni más que lo
 * que falta pagar (la diferencia la paga el comensal con otro medio).
 */
export function voucherApplicableCents(
  balanceCents: number,
  outstandingCents: number,
): number {
  return Math.max(0, Math.min(balanceCents, outstandingCents));
}
