// Propinas devueltas por ANULACIÓN — lo que baja las propinas que se le
// deben al equipo (cierre de turno, «Yo» del mesero, reporte del día).
//
// Una nota crédito de anulación aceptada por la DIAN le devuelve al cliente
// la propina de la cuenta (regla en erp/creditNoteTips.ts). Esa propina ya
// no es del equipo: se resta de las propinas del DÍA DE LA NOTA (el instante
// de su emisión firmada, `DianDocument.issuedAt`), como una línea negativa
// «Propina devuelta por anulación (NC…)». No se reescribe el turno donde se
// cobró la cuenta original: ese turno quedó cerrado con lo que se cobró.
//
// Si la propina ya se le había pagado al equipo, las propinas netas del día
// pueden quedar en negativo: se muestra tal cual (no se esconde ni se
// recorta a 0), porque es plata que el equipo recibió de más.
//
// Con propinas por mesero, la devuelta se reparte entre quienes cobraron la
// propina original, en proporción a lo que cobró cada uno.
import { db } from "@/lib/db";
import { acceptedCreditNoteWhere, creditNoteInstant, ensureCreditNoteStamps } from "@/lib/erp/creditNoteAccounting";
import { allocateTipByCollector } from "@/lib/erp/creditNoteTips";

export type TipReturn = {
  creditNoteId: string;
  /** Número de la nota ("NC3"). */
  documentNumber: string;
  /** Instante de la nota (emisión firmada): define el turno y el día. */
  at: Date;
  /** Propina devuelta por la nota (toda). */
  cents: number;
  /** Reparto entre quienes cobraron la propina (null = el comensal desde su QR). */
  byCollector: Array<{ userId: string | null; cents: number }>;
};

/** Una línea «Propina devuelta por anulación (NC…)» de un turno o un día. */
export type TipReturnLine = { creditNoteId: string; documentNumber: string; cents: number };

/**
 * Notas de anulación aceptadas, con propina devuelta, cuyo instante cae en
 * [from, to] (`to` null = hasta ahora). Antes fija las notas aceptadas que
 * quedaron sin fijar (las anteriores a la regla calculan su propina ahí). Un
 * fallo acá nunca tumba la pantalla que la usa: devuelve [] y lo registra.
 */
export async function loadTipReturns(
  restaurantId: string,
  window: { from: Date; to: Date | null },
): Promise<TipReturn[]> {
  try {
    await ensureCreditNoteStamps(restaurantId);
    const to = window.to ?? new Date();
    const range = { gte: new Date(window.from.getTime()), lte: to };
    const rows = await db.creditNote.findMany({
      where: {
        ...acceptedCreditNoteWhere(restaurantId),
        tipRefundCents: { gt: 0 },
        OR: [{ dianDocument: { is: { issuedAt: range } } }, { createdAt: range }],
      },
      select: {
        id: true,
        documentNumber: true,
        tipRefundCents: true,
        createdAt: true,
        dianDocument: { select: { issuedAt: true } },
        originalInvoice: {
          select: { order: { select: { payments: { select: { status: true, tipCents: true, collectedByUserId: true } } } } },
        },
      },
      orderBy: { createdAt: "asc" },
    });
    return rows
      .map((r) => ({ row: r, at: creditNoteInstant(r) }))
      .filter(({ at }) => at >= window.from && at <= to)
      .sort((a, b) => a.at.getTime() - b.at.getTime())
      .map(({ row, at }) => {
        const cents = row.tipRefundCents ?? 0;
        return {
          creditNoteId: row.id,
          documentNumber: row.documentNumber,
          at,
          cents,
          byCollector: allocateTipByCollector(cents, row.originalInvoice.order?.payments ?? []),
        };
      });
  } catch (error) {
    console.error("[tips] no se pudieron leer las propinas devueltas por anulación", {
      restaurantId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Líneas para mostrar: todas (turno o día del local) o sólo la parte de
 * un mesero (`collectedByUserId`), sin las que no le tocan.
 */
export function tipReturnLines(returns: readonly TipReturn[], collectedByUserId?: string | null): TipReturnLine[] {
  return returns
    .map((r) => ({
      creditNoteId: r.creditNoteId,
      documentNumber: r.documentNumber,
      cents:
        collectedByUserId === undefined
          ? r.cents
          : r.byCollector.filter((c) => c.userId === collectedByUserId).reduce((s, c) => s + c.cents, 0),
    }))
    .filter((l) => l.cents > 0);
}

export const sumTipReturnLines = (lines: readonly TipReturnLine[]) => lines.reduce((s, l) => s + l.cents, 0);
