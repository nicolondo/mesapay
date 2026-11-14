/**
 * Rótulo de un documento del proveedor (compra o gasto) en las notas
 * crédito: «Factura FE-123 · OC-0007», «OC-0007», «Gasto · Arriendo».
 */
type Tr = (key: string, values?: Record<string, string | number>) => string;

export function docLabel(
  t: Tr,
  d: { kind: "purchase" | "expense"; number: string | null; purchaseNumber?: number | null; concept?: string | null },
): string {
  if (d.kind === "purchase") {
    const oc = d.purchaseNumber != null ? t("docPurchase", { number: String(d.purchaseNumber).padStart(4, "0") }) : null;
    return [d.number ? t("docInvoice", { number: d.number }) : null, oc].filter(Boolean).join(" · ");
  }
  return [t("docExpense"), d.number || d.concept].filter(Boolean).join(" · ");
}
