// Barrido de emisión a la DIAN — la red de seguridad de la emisión
// automática.
//
// El caso normal lo resuelve el intento inmediato de `issueInvoiceOnPaid`
// (segundos después del cobro). Esto retoma lo que ese intento no logró:
// el proceso murió, la DIAN estaba caída (backoff), la configuración
// estaba incompleta (y el operador la completó), o el rango de la
// resolución se había agotado (y ya hay resolución nueva). Corre desde
// `POST /api/cron/dian-emit`, disparado por un systemd timer.
//
// Secuencial a propósito: una emisión a la vez contra la DIAN. El cerrojo
// contra el intento inmediato y contra otro barrido que se solape es el
// reclamo por estado dentro de `emitDianInvoice` (updateMany → `sent`).
import { db } from "@/lib/db";
import {
  emitDianInvoice,
  isRestaurantWideReason,
  markDocumentBlocked,
  type EmitBlockReason,
} from "@/lib/dian/emitInvoice";
import { claimableDianWhere, DEFAULT_SWEEP_LIMIT } from "@/lib/dian/retry";
import { issueInvoiceOnPaid } from "@/lib/invoiceOnPaid";

export type SweepSummary = {
  /** Documentos que el filtro dejó pasar (hasta `limit`). */
  scanned: number;
  accepted: number;
  pending: number;
  rejected: number;
  error: number;
  /** Frenados por configuración (o por rango agotado): sin consumir nada. */
  blocked: number;
  /** Reclamados por otro entre la lectura y el intento, o sin nada que hacer. */
  skipped: number;
  /** Se cortó por presupuesto de tiempo antes de terminar el lote. */
  truncated: boolean;
};

export async function sweepDianEmissions(opts: {
  now?: Date;
  limit?: number;
  /** Tope de tiempo del barrido; lo que no entra queda para el próximo. */
  budgetMs?: number;
} = {}): Promise<SweepSummary> {
  const now = opts.now ?? new Date();
  const budgetMs = opts.budgetMs ?? 50_000;
  const startedAt = Date.now();
  const summary: SweepSummary = {
    scanned: 0,
    accepted: 0,
    pending: 0,
    rejected: 0,
    error: 0,
    blocked: 0,
    skipped: 0,
    truncated: false,
  };

  const docs = await db.dianDocument.findMany({
    where: claimableDianWhere(now),
    orderBy: { createdAt: "asc" },
    take: opts.limit ?? DEFAULT_SWEEP_LIMIT,
    select: { id: true, restaurantId: true, simpleInvoiceId: true, orderId: true },
  });

  // Config rota = TODOS los documentos del comercio bloqueados por lo
  // mismo. Con el primero alcanza para saberlo; los demás del lote se
  // marcan sin cargar certificado ni resolver emisor otra vez.
  const blockedRestaurants = new Map<string, EmitBlockReason>();

  for (const doc of docs) {
    if (Date.now() - startedAt > budgetMs) {
      summary.truncated = true;
      break;
    }
    summary.scanned++;
    const known = blockedRestaurants.get(doc.restaurantId);
    if (known) {
      await markDocumentBlocked(doc.id, known, now);
      summary.blocked++;
      continue;
    }
    try {
      if (!doc.simpleInvoiceId) {
        // Placeholder de `numbering_exhausted`: no hay tirilla todavía.
        // Se vuelve a pasar por el riel del cobro, que numera si ya hay
        // rango y adopta este mismo documento.
        if (!doc.orderId) {
          summary.skipped++;
          continue;
        }
        const r = await issueInvoiceOnPaid({
          tenantId: doc.restaurantId,
          orderId: doc.orderId,
          emit: "inline",
        });
        if (r.status === "blocked") {
          // Sigue sin rango: `recordNumberingExhausted` ya corrió la
          // espera. NO se marca el comercio entero: sus tirillas ya
          // numeradas dentro del rango sí pueden salir.
          summary.blocked++;
        } else if (r.status === "issued" && r.emit) {
          tally(summary, r.emit, doc.restaurantId, blockedRestaurants);
        } else {
          summary.skipped++;
        }
        continue;
      }
      const r = await emitDianInvoice({
        simpleInvoiceId: doc.simpleInvoiceId,
        restaurantId: doc.restaurantId,
        now,
      });
      tally(summary, r, doc.restaurantId, blockedRestaurants);
    } catch (err) {
      // `emitDianInvoice` ya deja el documento en `error` con backoff en
      // casi todos los caminos; esto es por si revienta antes de eso. El
      // barrido sigue con el próximo: un documento roto no tapa la cola.
      summary.error++;
      console.error("[dian-sweep] documento", doc.id, err);
    }
  }
  return summary;
}

function tally(
  summary: SweepSummary,
  r: Awaited<ReturnType<typeof emitDianInvoice>>,
  restaurantId: string,
  blockedRestaurants: Map<string, EmitBlockReason>,
): void {
  switch (r.outcome) {
    case "accepted":
    case "pending":
    case "rejected":
    case "error":
      summary[r.outcome]++;
      return;
    case "blocked":
      summary.blocked++;
      if (isRestaurantWideReason(r.reason)) blockedRestaurants.set(restaurantId, r.reason);
      return;
    default:
      summary.skipped++;
  }
}
