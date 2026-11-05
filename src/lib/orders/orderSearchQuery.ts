import "server-only";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  creditNoteMatchesSearch,
  invoiceMatchesSearch,
  parseDocumentSearch,
} from "./orderSearch";

/** Tope de coincidencias por número: un consecutivo se repite, como mucho, una vez por resolución. */
const MAX_MATCHES = 50;

/**
 * Órdenes del comercio cuya factura —o una nota crédito sobre su factura—
 * tiene el número buscado (reglas en `orderSearch.ts`). Sin filtro de
 * fecha: una factura se busca en toda la historia.
 *
 * El prefijo se lee del snapshot con una ruta JSON (`->>`), sin traer la
 * tirilla entera, igual que la lista de Facturas.
 */
export async function findOrderIdsByDocumentNumber(
  restaurantId: string,
  q: string,
): Promise<string[]> {
  const search = parseDocumentSearch(q);
  if (!search) return [];
  const [invoices, notes] = await Promise.all([
    db.$queryRaw<{ orderId: string; invoiceNumber: number; prefix: string | null }[]>(Prisma.sql`
      SELECT "orderId", "invoiceNumber", "snapshot"->>'invoicePrefix' AS "prefix"
        FROM "SimpleInvoice"
       WHERE "restaurantId" = ${restaurantId}
         AND "invoiceNumber" IN (${Prisma.join(search.invoiceNumbers)})
       LIMIT ${MAX_MATCHES}`),
    search.creditNoteNumber
      ? db.creditNote.findMany({
          where: { restaurantId, number: { in: search.invoiceNumbers } },
          select: { documentNumber: true, originalInvoice: { select: { orderId: true } } },
          take: MAX_MATCHES,
        })
      : Promise.resolve([]),
  ]);
  const ids = new Set<string>();
  for (const inv of invoices) if (invoiceMatchesSearch(search, inv)) ids.add(inv.orderId);
  for (const note of notes) {
    if (creditNoteMatchesSearch(search, note.documentNumber)) ids.add(note.originalInvoice.orderId);
  }
  return [...ids];
}
