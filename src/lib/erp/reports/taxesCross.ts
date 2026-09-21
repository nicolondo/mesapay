/**
 * IMPUESTOS DEL PERÍODO — cruce DOCUMENTAL vs LIBRO (lógica pura). Portado
 * de zenith `impuestos-resumen.tsx` (`TaxBookComparison`), extendido a las
 * retenciones practicadas (que en MESAPAY sí tienen cifra documental: las
 * cabeceras de las compras).
 *
 * Por familia: la REFERENCIA que dicen los documentos frente al MOVIMIENTO
 * neto del libro en las cuentas de la familia, y la diferencia. Las
 * diferencias no prueban un error por sí solas: el libro también lleva
 * pagos de declaraciones, ajustes y comprobantes manuales del período.
 *
 *  · iva:        IVA generado en ventas − IVA DESCONTABLE de compras (la
 *                parte no descontable el motor la manda al gasto, no a
 *                2408: por eso se cruza contra el descontable y no contra
 *                todo el IVA registrado).
 *  · consumo:    INC generado en ventas (el INC de compras es costo).
 *  · retefuente / reteiva / reteica: retenciones de cabecera de compras.
 */
import type { DocumentTaxes } from "./taxesDocuments";
import { familySubtotal, type TaxAccountReport } from "./taxesModel";

export type CrossFamily = "iva" | "consumo" | "retefuente" | "reteiva" | "reteica";

export type CrossRow = {
  key: CrossFamily;
  referenceCents: number;
  bookCents: number;
  /** libro − documental. */
  differenceCents: number;
};

const CROSS_FAMILIES: readonly CrossFamily[] = [
  "iva",
  "consumo",
  "retefuente",
  "reteiva",
  "reteica",
];

function referenceOf(docs: DocumentTaxes, key: CrossFamily): number {
  const t = docs.totals;
  switch (key) {
    case "iva":
      return t.ivaGeneradoCents - t.ivaDescontableCents;
    case "consumo":
      return t.incGeneradoCents;
    case "retefuente":
      return t.retefuenteCents;
    case "reteiva":
      return t.reteIvaCents;
    case "reteica":
      return t.reteIcaCents;
  }
}

/** Filas del cruce; se omiten las familias sin cifra en ninguno de los dos lados. */
export function buildTaxCross(docs: DocumentTaxes, book: TaxAccountReport): CrossRow[] {
  return CROSS_FAMILIES.map((key) => {
    const referenceCents = referenceOf(docs, key);
    const bookCents = familySubtotal(book, key);
    return { key, referenceCents, bookCents, differenceCents: bookCents - referenceCents };
  }).filter((r) => r.referenceCents !== 0 || r.bookCents !== 0);
}
