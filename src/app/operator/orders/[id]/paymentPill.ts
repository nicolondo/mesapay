/**
 * Etiqueta (clave de `opOrders`) y tono del estado de un pago en el detalle
 * de la orden. Va por `PaymentStatus` (pending / approved / declined /
 * refunded): antes se preguntaba por `failed`, que no existe, y un pago
 * rechazado — también uno conciliado a mano como «Cobro rechazado» — salía
 * como «Pendiente».
 */
export type PaymentPillTone = "ok" | "danger" | "muted";

export function paymentPill(status: string): {
  key: "payApproved" | "payDeclined" | "payRefunded" | "payPending";
  tone: PaymentPillTone;
} {
  switch (status) {
    case "approved":
      return { key: "payApproved", tone: "ok" };
    case "declined":
      return { key: "payDeclined", tone: "danger" };
    case "refunded":
      return { key: "payRefunded", tone: "muted" };
    default:
      return { key: "payPending", tone: "muted" };
  }
}
