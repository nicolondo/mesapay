// Emisión de documentos DIAN desde una factura simple (ERP B1.6).
//
// Puente entre el flujo de facturación actual (SimpleInvoice, que ya
// existe como representación gráfica) y la DIAN: mapea la orden a líneas
// UBL, construye, firma, envía (SendBillSync en producción) y persiste
// el DianDocument. NUNCA bloquea la venta: si la DIAN rechaza o se cae,
// el documento queda con estado y errores legibles, con botón reintentar
// desde la UI (B1.6b).
import { db } from "@/lib/db";
import { splitTaxIncludedCents, type DianLine } from "@/lib/dian/ubl";

export type OrderItemForInvoice = {
  nameSnapshot: string;
  qty: number;
  priceCentsSnapshot: number;
  cancelledAt: Date | null;
};

/**
 * Mapea los items vivos de una orden a líneas UBL (pura). El precio de
 * carta es impuesto-incluido; se reparte base + impuesto con `taxPctTimes100`
 * (0 = sin impuesto, 800 = INC 8%, 1900 = IVA 19%). Items cancelados
 * fuera. Devuelve líneas con enteros exactos.
 */
export function orderToInvoiceLines(
  items: OrderItemForInvoice[],
  taxPctTimes100: number,
  taxSchemeId: "01" | "04",
): DianLine[] {
  const lines: DianLine[] = [];
  for (const it of items) {
    if (it.cancelledAt || it.qty <= 0) continue;
    const grossLine = it.priceCentsSnapshot * it.qty;
    const { baseCents, taxCents } = splitTaxIncludedCents(grossLine, taxPctTimes100);
    const unit = splitTaxIncludedCents(it.priceCentsSnapshot, taxPctTimes100).baseCents;
    lines.push({
      description: it.nameSnapshot,
      quantity: it.qty,
      unitPriceCents: unit,
      lineTotalCents: baseCents,
      taxCents,
      taxPct: (taxPctTimes100 / 100).toFixed(2),
      taxSchemeId,
    });
  }
  return lines;
}

/** Hora Colombia "HH:mm:ss-05:00" para el XML/CUFE. */
export function bogotaIssueTime(now: Date): string {
  return (
    now.toLocaleTimeString("en-GB", { hour12: false, timeZone: "America/Bogota" }) +
    "-05:00"
  );
}

/**
 * Marca de idempotencia: reclama la emisión de un SimpleInvoice creando
 * su DianDocument sólo si no existe (o si el anterior quedó reintentable).
 * Devuelve el documento a (re)enviar o null si ya está aceptado/en curso.
 */
export async function claimDianDocument(
  simpleInvoiceId: string,
  restaurantId: string,
): Promise<{ id: string } | null> {
  const existing = await db.dianDocument.findUnique({
    where: { simpleInvoiceId },
    select: { id: true, state: true },
  });
  if (existing) {
    // Sólo se reintenta lo reintentable (error/rejected); aceptado o en
    // vuelo no se re-emite.
    if (existing.state === "error" || existing.state === "rejected") {
      return { id: existing.id };
    }
    return null;
  }
  const created = await db.dianDocument.create({
    data: {
      restaurantId,
      simpleInvoiceId,
      kind: "invoice",
      state: "to_send",
    },
    select: { id: true },
  });
  return { id: created.id };
}
