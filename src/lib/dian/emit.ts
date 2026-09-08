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
import { isOwnTaxLine, type RestaurantTax, type SalesTaxKind } from "@/lib/salesTax";

/** Misma regla que salesTax.isOwnTaxLine, sobre el item de la orden. */
function ownTaxItem(it: OrderItemForInvoice): boolean {
  return isOwnTaxLine({ amountCents: 0, taxKind: it.taxKind, taxPct: it.taxPct });
}

export type OrderItemForInvoice = {
  nameSnapshot: string;
  qty: number;
  priceCentsSnapshot: number;
  cancelledAt: Date | null;
  /** null ⇒ plato del menú (impuesto embebido con la tarifa del comercio). */
  taxKind: string | null;
  taxPct: number | null;
};

/** Tipo de impuesto → código del anexo: "01" IVA, "04" impoconsumo. */
function schemeOf(kind: SalesTaxKind): "01" | "04" {
  return kind === "inc" ? "04" : "01";
}

/**
 * Mapea los items vivos de una orden a líneas UBL (pura). Respeta los DOS
 * regímenes que conviven en una cuenta (ver src/lib/salesTax.ts):
 *
 *   · Plato de carta (taxKind null) → el impuesto va DENTRO del precio,
 *     con la tarifa del comercio: se reparte base + impuesto.
 *   · Línea libre (taxKind propio) → el impuesto se SUMA ENCIMA: la base
 *     es el precio tal cual y el impuesto se calcula sobre él.
 *
 * Antes se forzaba una sola tarifa para toda la factura, así que una
 * cuenta con un plato en INC 8% y un servicio en IVA 19% se enviaba a la
 * DIAN sin impuestos. Items cancelados fuera. Enteros exactos.
 */
export function orderToInvoiceLines(
  items: OrderItemForInvoice[],
  restaurantTax: RestaurantTax,
): DianLine[] {
  const lines: DianLine[] = [];
  for (const it of items) {
    if (it.cancelledAt || it.qty <= 0) continue;
    const grossLine = it.priceCentsSnapshot * it.qty;
    const own = ownTaxItem(it);
    const kind = (own ? it.taxKind : restaurantTax.kind) as SalesTaxKind;
    const pct = own ? (it.taxPct ?? 0) : restaurantTax.pct;
    const effectivePct = kind === "none" ? 0 : pct;

    let lineTotalCents: number;
    let unitPriceCents: number;
    let taxCents: number;
    if (own) {
      // Impuesto encima: la base es el precio de la línea.
      lineTotalCents = grossLine;
      unitPriceCents = it.priceCentsSnapshot;
      taxCents =
        effectivePct > 0 && grossLine > 0
          ? Math.round((grossLine * effectivePct) / 100)
          : 0;
    } else {
      // Impuesto embebido: base = bruto − impuesto (suman exacto).
      const split = splitTaxIncludedCents(grossLine, effectivePct * 100);
      lineTotalCents = split.baseCents;
      taxCents = split.taxCents;
      unitPriceCents = splitTaxIncludedCents(
        it.priceCentsSnapshot,
        effectivePct * 100,
      ).baseCents;
    }

    lines.push({
      description: it.nameSnapshot,
      quantity: it.qty,
      unitPriceCents,
      lineTotalCents,
      taxCents,
      taxPct: effectivePct.toFixed(2),
      taxSchemeId: schemeOf(kind),
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
