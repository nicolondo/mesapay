// Recuperación de facturas electrónicas que la DIAN no dejó aceptadas por
// una causa que ya no aplica: la línea en $0 (FAW01, ya no se manda), la
// regla 90 (la DIAN ya la tenía) y las respuestas transitorias de la DIAN
// (sólo notificaciones, o su plantilla sin armar — RUT01 «{StatusRut}»).
//
// Dos puertas, la misma lógica:
//   · el staff, factura por factura, desde Facturas («Reenviar a la DIAN» /
//     «Consultar en la DIAN») — `POST /api/operator/dian/documents/[id]/recover`;
//   · el admin de plataforma, en lote, desde el panel del comercio — con
//     listado previo (dry-run), tope por corrida y pausa entre envíos.
//
// Reenviar = `emitDianInvoice` de siempre: MISMA SimpleInvoice, MISMO
// número (la DIAN no registra un documento rechazado, así que el
// consecutivo no se gastó), XML armado de nuevo con la regla de hoy (sin
// líneas en $0), fecha de emisión y CUFE nuevos. Antes de mandar, la
// emisión le pregunta a la DIAN por el CUFE anterior (por si lo tenía).
// Consultar = `checkDianInvoiceStatus`: GetStatus por CUFE.
//
// Idempotente: una factura aceptada ya no aparece como recuperable, y cada
// acción pasa por el reclamo del documento (`sent`), así que dos clics o
// dos lotes a la vez no mandan dos veces. Cada acción queda en el audit log.
import { db } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auditLog";
import { documentErrors } from "@/lib/dian/config";
import { emitDianInvoice } from "@/lib/dian/emitInvoice";
import { shouldAutoPrintRecovered } from "@/lib/dian/invoiceAcceptance";
import { checkDianInvoiceStatus } from "@/lib/dian/invoiceReconcile";
import {
  dianRecoveryAdvice,
  DUPLICATE_UNVERIFIED,
  type DianRecoveryAction,
  type DianRejectionCause,
} from "@/lib/dian/invoiceResponse";
import { MAX_ATTEMPTS } from "@/lib/dian/retry";
import { formatInvoiceNumber, type InvoiceSnapshot } from "@/lib/invoice";

/** Lo que el lote procesa como mucho por corrida. */
export const MAX_BATCH = 25;
/** Pausa entre documentos del lote: una emisión a la vez y sin martillar a la DIAN. */
export const BATCH_PAUSE_MS = 1_500;
/** Presupuesto de tiempo de una corrida (lo que no entra queda para la siguiente). */
export const BATCH_BUDGET_MS = 45_000;

export type RecoverableInvoice = {
  documentId: string;
  simpleInvoiceId: string;
  number: string;
  createdAt: string;
  totalCents: number;
  state: string;
  cause: DianRejectionCause;
  action: DianRecoveryAction;
  /** Primer mensaje de la DIAN, tal cual (para el detalle). */
  lastError: string | null;
};

/** Las facturas del comercio que esperan a una persona (o al lote). */
export function recoverableWhere(restaurantId: string) {
  return {
    restaurantId,
    kind: "invoice",
    simpleInvoiceId: { not: null },
    OR: [
      { state: "rejected" },
      { state: "error", attempts: { gte: MAX_ATTEMPTS } },
      { state: "pending", lastError: DUPLICATE_UNVERIFIED },
    ],
  };
}

export async function listRecoverableInvoices(
  restaurantId: string,
  opts: { take?: number } = {},
): Promise<{ items: RecoverableInvoice[]; counts: Record<DianRejectionCause, number> }> {
  const docs = await db.dianDocument.findMany({
    where: recoverableWhere(restaurantId),
    orderBy: { createdAt: "asc" },
    take: opts.take ?? 500,
    select: {
      id: true,
      state: true,
      lastError: true,
      errors: true,
      simpleInvoice: {
        select: { id: true, invoiceNumber: true, snapshot: true, createdAt: true, totalCents: true },
      },
    },
  });
  const counts: Record<DianRejectionCause, number> = {
    zero_value_line: 0,
    already_at_dian: 0,
    dian_notification: 0,
    dian_transient: 0,
    other: 0,
  };
  const items: RecoverableInvoice[] = [];
  for (const d of docs) {
    const inv = d.simpleInvoice;
    if (!inv) continue;
    const errors = documentErrors(d.errors);
    const advice = dianRecoveryAdvice({ state: d.state, lastError: d.lastError, errors }) ?? {
      cause: "other" as const,
      action: "none" as const,
    };
    counts[advice.cause]++;
    items.push({
      documentId: d.id,
      simpleInvoiceId: inv.id,
      number: formatInvoiceNumber(inv.snapshot as unknown as InvoiceSnapshot, inv.invoiceNumber),
      createdAt: inv.createdAt.toISOString(),
      totalCents: inv.totalCents,
      state: d.state,
      cause: advice.cause,
      action: advice.action,
      lastError: d.lastError ?? errors[0] ?? null,
    });
  }
  return { items, counts };
}

export type RecoverOutcome =
  | "accepted"
  | "rejected"
  | "pending"
  | "unverified"
  | "error"
  | "blocked"
  /** Otro la está emitiendo / consultando, o ya quedó aceptada. */
  | "already"
  /** La acción pedida no es la que corresponde a su causa. */
  | "not_applicable"
  | "not_found";

export type RecoverResult = {
  documentId: string;
  number: string | null;
  action: DianRecoveryAction;
  outcome: RecoverOutcome;
  /** Motivo del bloqueo o primer mensaje del nuevo rechazo. */
  reason?: string | null;
};

/**
 * Una factura: reenviar o consultar, según su causa. `action` es lo que
 * pidió la persona; si no coincide con lo que corresponde, no se hace nada
 * (un botón viejo en pantalla no puede reenviar algo que la DIAN ya tiene).
 */
export async function recoverDianInvoice(opts: {
  documentId: string;
  restaurantId: string;
  action: Exclude<DianRecoveryAction, "none">;
  now?: Date;
  /** CUFE copiado del portal de la DIAN (sólo consulta; sólo vale si el acuse lo confirma). */
  extraCufe?: string | null;
  source: "operator" | "admin_batch" | "admin_single";
}): Promise<RecoverResult> {
  const now = opts.now ?? new Date();
  const doc = await db.dianDocument.findUnique({
    where: { id: opts.documentId },
    select: {
      id: true,
      restaurantId: true,
      kind: true,
      state: true,
      cufe: true,
      lastError: true,
      errors: true,
      attempts: true,
      simpleInvoice: { select: { id: true, invoiceNumber: true, snapshot: true, createdAt: true } },
    },
  });
  if (!doc || doc.restaurantId !== opts.restaurantId || doc.kind !== "invoice" || !doc.simpleInvoice) {
    return { documentId: opts.documentId, number: null, action: opts.action, outcome: "not_found" };
  }
  const inv = doc.simpleInvoice;
  const number = formatInvoiceNumber(inv.snapshot as unknown as InvoiceSnapshot, inv.invoiceNumber);
  const base = { documentId: doc.id, number, action: opts.action } as const;
  if (doc.state === "accepted") return { ...base, outcome: "already" };
  const advice = dianRecoveryAdvice({
    state: doc.state,
    lastError: doc.lastError,
    errors: documentErrors(doc.errors),
  });
  if (!advice || advice.action !== opts.action) return { ...base, outcome: "not_applicable" };

  let result: RecoverResult;
  if (opts.action === "resend") {
    const r = await emitDianInvoice({
      simpleInvoiceId: inv.id,
      restaurantId: opts.restaurantId,
      now,
      printOnAccept: shouldAutoPrintRecovered(inv.createdAt, now),
    });
    switch (r.outcome) {
      case "not_found":
        result = { ...base, outcome: "not_found" };
        break;
      case "already_emitted":
        result = { ...base, outcome: "already" };
        break;
      case "blocked":
        result = { ...base, outcome: "blocked", reason: r.reason };
        break;
      default:
        result = { ...base, outcome: r.outcome, reason: r.errors[0] ?? null };
    }
  } else {
    const r = await checkDianInvoiceStatus({
      documentId: doc.id,
      restaurantId: opts.restaurantId,
      now,
      extraCufe: opts.extraCufe,
    });
    switch (r.outcome) {
      case "accepted":
        result = { ...base, outcome: "accepted" };
        break;
      case "unverified":
        result = { ...base, outcome: r.channelError ? "error" : "unverified" };
        break;
      case "blocked":
        result = { ...base, outcome: "blocked", reason: r.reason };
        break;
      case "no_cufe":
        result = { ...base, outcome: "unverified", reason: "no_cufe" };
        break;
      case "not_applicable":
        result = { ...base, outcome: "already" };
        break;
      default:
        result = { ...base, outcome: "not_found" };
    }
  }

  // Constancia de TODO reenvío o consulta: quién, cuándo, qué número, qué
  // CUFE tenía y con cuál quedó.
  const after = await db.dianDocument.findUnique({
    where: { id: doc.id },
    select: { state: true, cufe: true, lastError: true, attempts: true },
  });
  await recordAuditEvent({
    kind: opts.action === "resend" ? "dian.invoice.resend" : "dian.invoice.status_check",
    restaurantId: opts.restaurantId,
    target: { type: "dian_document", id: doc.id },
    summary: `Factura ${number}: ${opts.action === "resend" ? "reenvío" : "consulta"} → ${result.outcome}`,
    diff: {
      before: {
        number,
        state: doc.state,
        cufe: doc.cufe,
        lastError: doc.lastError,
        attempts: doc.attempts,
        cause: advice.cause,
      },
      after: { ...(after ?? {}), outcome: result.outcome, source: opts.source },
    },
  });
  return result;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * El lote del admin: hasta `limit` facturas recuperables (las que tienen
 * acción), de la más vieja a la más nueva, una a la vez con pausa. Lo que
 * no entra en el presupuesto queda para la próxima corrida (`remaining`).
 */
export async function recoverRestaurantInvoices(opts: {
  restaurantId: string;
  limit?: number;
  now?: () => Date;
  pauseMs?: number;
  budgetMs?: number;
}): Promise<{ results: RecoverResult[]; remaining: number; truncated: boolean }> {
  const limit = Math.min(MAX_BATCH, Math.max(1, opts.limit ?? 10));
  const pause = opts.pauseMs ?? BATCH_PAUSE_MS;
  const budget = opts.budgetMs ?? BATCH_BUDGET_MS;
  const startedAt = Date.now();
  const { items } = await listRecoverableInvoices(opts.restaurantId);
  const actionable = items.filter(
    (i): i is RecoverableInvoice & { action: Exclude<DianRecoveryAction, "none"> } => i.action !== "none",
  );
  const results: RecoverResult[] = [];
  let truncated = false;
  for (const item of actionable.slice(0, limit)) {
    if (Date.now() - startedAt > budget) {
      truncated = true;
      break;
    }
    if (results.length > 0 && pause > 0) await sleep(pause);
    try {
      results.push(
        await recoverDianInvoice({
          documentId: item.documentId,
          restaurantId: opts.restaurantId,
          action: item.action,
          now: opts.now?.(),
          source: "admin_batch",
        }),
      );
    } catch (err) {
      console.error("[dian-recovery] documento", item.documentId, err);
      results.push({ documentId: item.documentId, number: item.number, action: item.action, outcome: "error" });
    }
  }
  const done = new Set(results.map((r) => r.documentId));
  await recordAuditEvent({
    kind: "dian.invoice.recovery_batch",
    restaurantId: opts.restaurantId,
    target: { type: "restaurant", id: opts.restaurantId },
    summary: `Recuperación DIAN en lote: ${results.length} facturas`,
    diff: {
      after: {
        processed: results.length,
        byOutcome: results.reduce<Record<string, number>>((acc, r) => {
          acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
          return acc;
        }, {}),
      },
    },
  });
  return {
    results,
    remaining: actionable.filter((i) => !done.has(i.documentId)).length,
    truncated,
  };
}
