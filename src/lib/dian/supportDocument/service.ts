// Emisión del documento soporte y de su nota de ajuste: numerar, armar,
// firmar, transmitir y seguir el estado. Reutiliza la base de la factura
// electrónica (firma XAdES, ZIP, SOAP firmado, parseo de respuestas).
//
// Garantías:
//   · Un solo documento soporte VIGENTE por gasto o compra (`activeKey`
//     único). Se libera sólo cuando una nota de ajuste de anulación queda
//     aceptada.
//   · El número se asigna en la MISMA transacción que crea el documento y
//     sólo después de validar configuración, vendedor y contenido: nunca se
//     gasta un número en algo que de entrada no podía salir.
//   · `sent` es el cerrojo del envío (updateMany condicionado por estado).
//   · Los bytes firmados se guardan ANTES de transmitir; un error de canal
//     se recupera consultando por CUDS y reenviando esos MISMOS bytes. Un
//     rechazo de la DIAN (99) se corrige y se reenvía con el MISMO número
//     (un documento rechazado no queda registrado en la DIAN).
//   · Habilitación (ProfileExecutionID 2) nunca tiene validez fiscal.
//   · No genera asientos: el gasto o la compra ya registraron el costo, el
//     IVA, las retenciones y la cuenta por pagar.
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { dianIssueDateTime, dianSigningTime } from "@/lib/dian/dianDateTime";
import { BLOCKED_RETRY_MS, emissionBackoffMs, MAX_ATTEMPTS, STALE_CLAIM_MS } from "@/lib/dian/retry";
import {
  getStatus,
  getStatusZip,
  sendBillSync,
  sendTestSetAsync,
  zipInvoice,
  type DianResult,
} from "@/lib/dian/soap";
import { signXmlDian } from "@/lib/dian/xades";
import {
  ADJUSTMENT_DESCRIPTION_MAX,
  ADJUSTMENT_DESCRIPTION_MIN,
  ADJUSTMENT_REASONS,
  VOID_REASON,
  type AdjustmentReasonCode,
} from "./constants";
import { loadSupportDocConfig, type LoadedSupportDocConfig } from "./config";
import { SupportDocError } from "./errors";
import { allocateNumber, nextFileSequence, supportDocFileNames } from "./numbering";
import { customizationFor, missingSellerFields, sellerFromSupplier } from "./seller";
import {
  activeKeyFor,
  generationFormFor,
  loadSupportDocDraft,
  proportionalSplit,
  type SupportDocDraft,
} from "./source";
import type {
  SupportDocKind,
  SupportDocLine,
  SupportDocSnapshot,
  SupportDocSourceType,
} from "./types";
import { buildAdjustmentNoteXml, buildSupportDocumentXml, computeSupportDocTotals } from "./xml";

export type SupportDocOutcome = {
  id: string;
  documentNumber: string;
  state: string;
  errors: string[];
};

/** Estados desde los que se puede (re)transmitir. `rejected` sólo a mano. */
const RETRYABLE = ["to_send", "error", "rejected"] as const;

/** Respuestas de consulta que significan «la DIAN no lo tiene (todavía)». */
function notFound(r: DianResult): boolean {
  const code = r.statusCode?.trim();
  return code === "66" || code === "90";
}

/** Regla 90 al ENVIAR: ya existe un documento con ese número. */
function isDuplicate(r: DianResult): boolean {
  return r.errors.some((e) => /Regla:\s*90\b/i.test(e));
}

function snapshotOf(value: Prisma.JsonValue): SupportDocSnapshot {
  return value as unknown as SupportDocSnapshot;
}

/** Contenido del documento soporte a partir del borrador (gasto o compra). */
function snapshotFromDraft(
  draft: SupportDocDraft,
  config: LoadedSupportDocConfig,
): SupportDocSnapshot {
  if (!draft.supplier) throw new SupportDocError("no_supplier");
  const missing = missingSellerFields(draft.supplier);
  if (missing.includes("not_flagged")) throw new SupportDocError("supplier_not_flagged");
  if (missing.length) throw new SupportDocError("supplier_incomplete", missing);
  return {
    version: 1,
    kind: "support_document",
    customizationId: customizationFor(draft.supplier),
    seller: sellerFromSupplier(draft.supplier),
    buyer: config.buyer,
    lines: draft.lines,
    paymentMeans: draft.paymentMeans,
    note: null,
    resolution: config.resolution,
    reference: null,
    reasonCode: null,
    reasonText: null,
    source: {
      type: draft.sourceType,
      id: draft.sourceId,
      label: draft.sourceLabel,
      operationDate: draft.operationDate,
    },
    untransmittedWithholdings: draft.untransmittedWithholdings,
    issueDate: null,
    issueTime: null,
  };
}

/** DSAD09: la fecha de emisión tiene que caer en la vigencia de la autorización. */
function assertResolutionValid(config: LoadedSupportDocConfig, now: Date): void {
  const today = dianIssueDateTime(now).date;
  if (today < config.resolution.startDate || today > config.resolution.endDate) {
    throw new SupportDocError("resolution_expired");
  }
}

function totalsColumns(lines: SupportDocLine[]) {
  const t = computeSupportDocTotals(lines);
  return {
    subtotalCents: t.lineExtensionCents,
    taxCents: t.ivaCents,
    withholdingCents: t.withholdingCents,
    totalCents: t.payableCents,
  };
}

// ── Creación ────────────────────────────────────────────────────────────────

/**
 * Genera el documento soporte de un gasto o de una compra recibida y lo
 * transmite. Valida TODO antes de numerar.
 */
export async function createSupportDocument(args: {
  restaurantId: string;
  userId: string | null;
  sourceType: SupportDocSourceType;
  sourceId: string;
  now?: Date;
}): Promise<SupportDocOutcome> {
  const now = args.now ?? new Date();
  const config = await loadSupportDocConfig(args.restaurantId, { now });
  assertResolutionValid(config, now);
  const draft = await loadSupportDocDraft(args.restaurantId, args.sourceType, args.sourceId, now);
  const snapshot = snapshotFromDraft(draft, config);
  const activeKey = activeKeyFor(args.sourceType, args.sourceId);
  const existing = await db.supportDocument.findUnique({ where: { activeKey }, select: { id: true } });
  if (existing) throw new SupportDocError("already_exists");

  let created: { id: string; documentNumber: string };
  try {
    created = await db.$transaction(async (tx) => {
      const { seriesId, number } = await allocateNumber(tx, {
        issuerNit: config.buyer.nit,
        environment: config.envCode,
        kind: "support_document",
        prefix: config.resolution.prefix,
        from: config.resolution.from,
        to: config.resolution.to,
      });
      return tx.supportDocument.create({
        data: {
          restaurantId: args.restaurantId,
          kind: "support_document",
          sourceType: args.sourceType,
          expenseId: args.sourceType === "expense" ? args.sourceId : null,
          purchaseOrderId: args.sourceType === "purchase_order" ? args.sourceId : null,
          activeKey,
          seriesId,
          number,
          documentNumber: `${config.resolution.prefix}${number}`,
          environment: config.envCode,
          issuerNit: config.buyer.nit,
          snapshot: snapshot as unknown as Prisma.InputJsonValue,
          ...totalsColumns(snapshot.lines),
          state: "to_send",
          createdById: args.userId,
        },
        select: { id: true, documentNumber: true },
      });
    });
  } catch (err) {
    // Otra generación del mismo gasto/compra ganó la carrera: el número de
    // esta transacción se deshizo con ella.
    if ((err as { code?: string })?.code === "P2002") throw new SupportDocError("already_exists");
    throw err;
  }
  return transmitSupportDocument({ restaurantId: args.restaurantId, id: created.id, now, config });
}

/**
 * Nota de ajuste (CreditNote 95) a un documento soporte ACEPTADO. Con el
 * concepto 2 (anulación) ajusta todo lo que queda del documento; con los
 * demás, el valor base que indique el operador, repartido entre las líneas
 * en proporción (el IVA lo sigue). No lleva retenciones (§8.2 del anexo).
 */
export async function createAdjustmentNote(args: {
  restaurantId: string;
  userId: string | null;
  supportDocumentId: string;
  reasonCode: string;
  reasonText: string;
  /** Base a ajustar (sin IVA). Ignorado en la anulación. */
  amountCents?: number | null;
  now?: Date;
}): Promise<SupportDocOutcome> {
  const now = args.now ?? new Date();
  if (!(args.reasonCode in ADJUSTMENT_REASONS)) throw new SupportDocError("invalid_reason");
  const reasonCode = args.reasonCode as AdjustmentReasonCode;
  const reasonText = args.reasonText.trim();
  if (reasonText.length < ADJUSTMENT_DESCRIPTION_MIN || reasonText.length > ADJUSTMENT_DESCRIPTION_MAX) {
    throw new SupportDocError("reason_too_short");
  }
  const ds = await db.supportDocument.findFirst({
    where: { id: args.supportDocumentId, restaurantId: args.restaurantId, kind: "support_document" },
    include: { adjustments: { select: { state: true, reasonCode: true, subtotalCents: true, taxCents: true } } },
  });
  if (!ds) throw new SupportDocError("not_found");
  if (ds.state !== "accepted" || !ds.cuds || !ds.issuedAt) throw new SupportDocError("not_adjustable");
  const config = await loadSupportDocConfig(args.restaurantId, { now });
  if (config.envCode !== ds.environment) throw new SupportDocError("environment_changed");

  // Lo ya ajustado (aceptado o en curso) no se puede volver a ajustar.
  const live = ds.adjustments.filter((a) => a.state !== "rejected");
  if (live.some((a) => a.reasonCode === VOID_REASON)) throw new SupportDocError("not_adjustable");
  const adjustedBase = live.reduce((a, n) => a + n.subtotalCents, 0);
  const adjustedIva = live.reduce((a, n) => a + n.taxCents, 0);
  const remainingBase = ds.subtotalCents - adjustedBase;
  const remainingIva = ds.taxCents - adjustedIva;
  if (remainingBase <= 0) throw new SupportDocError("not_adjustable");
  const base = reasonCode === VOID_REASON ? remainingBase : Math.round(args.amountCents ?? 0);
  if (!(base > 0)) throw new SupportDocError("empty_document");
  if (base > remainingBase) throw new SupportDocError("adjustment_exceeds");

  const source = snapshotOf(ds.snapshot);
  // Base e IVA de la nota, línea por línea, en proporción a lo que queda.
  const remainingByLine = proportionalSplit(remainingBase, source.lines.map((l) => l.lineTotalCents));
  const baseByLine = proportionalSplit(base, remainingByLine);
  const ivaTotal = remainingBase === base ? remainingIva : Math.round((remainingIva * base) / remainingBase);
  const ivaByLine = proportionalSplit(
    ivaTotal,
    source.lines.map((l, i) => (l.ivaCents > 0 ? baseByLine[i] : 0)),
  );
  const lines: SupportDocLine[] = source.lines
    .map((l, i) => ({
      ...l,
      quantity: 1,
      unitPriceCents: baseByLine[i],
      lineTotalCents: baseByLine[i],
      ivaCents: ivaByLine[i],
      withholdings: [],
    }))
    .filter((l) => l.lineTotalCents > 0);

  const snapshot: SupportDocSnapshot = {
    ...source,
    kind: "adjustment_note",
    lines,
    resolution: null,
    reference: {
      documentNumber: ds.documentNumber,
      cuds: ds.cuds,
      issueDate: source.issueDate ?? dianIssueDateTime(ds.issuedAt).date,
    },
    reasonCode,
    reasonText,
    untransmittedWithholdings: [],
    issueDate: null,
    issueTime: null,
  };

  const created = await db.$transaction(async (tx) => {
    const { seriesId, number } = await allocateNumber(tx, {
      issuerNit: config.buyer.nit,
      environment: config.envCode,
      kind: "adjustment_note",
      prefix: config.adjustmentPrefix,
      from: 1,
      to: 2147483646,
    });
    return tx.supportDocument.create({
      data: {
        restaurantId: args.restaurantId,
        kind: "adjustment_note",
        sourceType: ds.sourceType,
        expenseId: ds.expenseId,
        purchaseOrderId: ds.purchaseOrderId,
        adjustsId: ds.id,
        seriesId,
        number,
        documentNumber: `${config.adjustmentPrefix}${number}`,
        environment: config.envCode,
        issuerNit: config.buyer.nit,
        reasonCode,
        reasonText,
        snapshot: snapshot as unknown as Prisma.InputJsonValue,
        ...totalsColumns(lines),
        state: "to_send",
        createdById: args.userId,
      },
      select: { id: true },
    });
  });
  return transmitSupportDocument({ restaurantId: args.restaurantId, id: created.id, now, config });
}

// ── Reenvío y consulta ──────────────────────────────────────────────────────

/**
 * Reenvío manual. Tras un RECHAZO, el documento soporte se vuelve a armar
 * desde el gasto o la compra (con el proveedor ya corregido) y sale con el
 * MISMO número. Tras un error de canal se consulta primero por CUDS y, si la
 * DIAN no lo tiene, se reenvían los mismos bytes.
 */
export async function resendSupportDocument(args: {
  restaurantId: string;
  id: string;
  now?: Date;
}): Promise<SupportDocOutcome> {
  const now = args.now ?? new Date();
  const doc = await db.supportDocument.findFirst({ where: { id: args.id, restaurantId: args.restaurantId } });
  if (!doc) throw new SupportDocError("not_found");
  if (!(RETRYABLE as readonly string[]).includes(doc.state)) throw new SupportDocError("not_resendable");
  const config = await loadSupportDocConfig(args.restaurantId, { now });
  if (config.envCode !== doc.environment) throw new SupportDocError("environment_changed");
  if (doc.kind === "support_document" && doc.state === "rejected") {
    const sourceId = doc.expenseId ?? doc.purchaseOrderId;
    if (sourceId) {
      assertResolutionValid(config, now);
      const draft = await loadSupportDocDraft(args.restaurantId, doc.sourceType as SupportDocSourceType, sourceId, now);
      const fresh = snapshotFromDraft(draft, config);
      // La resolución del número ya asignado no cambia aunque la
      // configuración haya cargado una nueva.
      const kept = snapshotOf(doc.snapshot);
      fresh.resolution = kept.resolution ?? fresh.resolution;
      await db.supportDocument.updateMany({
        where: { id: doc.id, restaurantId: args.restaurantId, state: "rejected" },
        data: {
          snapshot: fresh as unknown as Prisma.InputJsonValue,
          ...totalsColumns(fresh.lines),
          // Un XML nuevo: los bytes del rechazado ya no sirven.
          xmlZip: null,
          cuds: null,
          submissionFileName: null,
        },
      });
    }
  }
  return transmitSupportDocument({ restaurantId: args.restaurantId, id: doc.id, now, config });
}

/** Consulta el estado en la DIAN de un documento pendiente (o enviado). */
export async function refreshSupportDocumentStatus(args: {
  restaurantId: string;
  id: string;
  now?: Date;
}): Promise<SupportDocOutcome> {
  const now = args.now ?? new Date();
  const doc = await db.supportDocument.findFirst({ where: { id: args.id, restaurantId: args.restaurantId } });
  if (!doc) throw new SupportDocError("not_found");
  if (!doc.cuds || !doc.xmlZip || !["pending", "error"].includes(doc.state)) {
    return outcome(doc);
  }
  const config = await loadSupportDocConfig(args.restaurantId, { now });
  const send = { environment: config.environment, cert: config.cert };
  let result = await getStatus(doc.cuds, send);
  if (notFound(result) && doc.trackId) result = await getStatusZip(doc.trackId, send);
  if (result.state === "error" || notFound(result)) {
    // Sin respuesta útil: nada cambia salvo la próxima consulta.
    await db.supportDocument.updateMany({
      where: { id: doc.id, state: doc.state },
      data: { nextAttemptAt: new Date(now.getTime() + 2 * 60_000) },
    });
    return outcome(doc);
  }
  await finalize(doc.id, args.restaurantId, result, doc.attempts, now, doc.state);
  return outcome(await db.supportDocument.findUniqueOrThrow({ where: { id: doc.id } }));
}

function outcome(doc: { id: string; documentNumber: string; state: string; errors: Prisma.JsonValue | null }): SupportDocOutcome {
  return {
    id: doc.id,
    documentNumber: doc.documentNumber,
    state: doc.state,
    errors: Array.isArray(doc.errors) ? doc.errors.map(String) : [],
  };
}

// ── Transmisión ─────────────────────────────────────────────────────────────

/**
 * Reclama, (re)arma si hace falta, firma, guarda y transmite. Devuelve el
 * estado final. Si otro proceso tiene el reclamo, devuelve el estado actual
 * sin tocar nada.
 */
export async function transmitSupportDocument(args: {
  restaurantId: string;
  id: string;
  now?: Date;
  config?: LoadedSupportDocConfig;
}): Promise<SupportDocOutcome> {
  const now = args.now ?? new Date();
  const doc = await db.supportDocument.findFirst({ where: { id: args.id, restaurantId: args.restaurantId } });
  if (!doc) throw new SupportDocError("not_found");
  const claimed = await db.supportDocument.updateMany({
    where: {
      id: doc.id,
      restaurantId: args.restaurantId,
      OR: [
        { state: { in: [...RETRYABLE] } },
        { state: "sent", updatedAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) } },
      ],
    },
    data: { state: "sent" },
  });
  if (claimed.count === 0) return outcome(doc);
  const previous = doc.state;
  const release = (data: Prisma.SupportDocumentUpdateManyMutationInput) =>
    db.supportDocument.updateMany({ where: { id: doc.id, state: "sent" }, data });

  try {
    const config = args.config ?? (await loadSupportDocConfig(args.restaurantId, { now }));
    if (config.envCode !== doc.environment) throw new SupportDocError("environment_changed");
    const send = { environment: config.environment, cert: config.cert };
    let zip: Buffer;
    let zipFileName: string;
    let result: DianResult | null = null;
    let attempts = doc.attempts;

    // Bytes ya firmados de un intento que pudo haber llegado a la DIAN (error
    // de canal, o un reclamo que murió a mitad): primero se pregunta por el
    // CUDS; nunca se arma un XML nuevo con el mismo número a ciegas.
    if (doc.xmlZip && doc.cuds && doc.submissionFileName && (previous === "error" || previous === "sent")) {
      // Reintento de un envío incierto: ¿la DIAN ya lo tiene?
      zip = Buffer.from(doc.xmlZip);
      zipFileName = doc.submissionFileName.replace(/^(ds|nas)/, "z").replace(/\.xml$/i, ".zip");
      let status = await getStatus(doc.cuds, send);
      if (notFound(status) && doc.trackId) status = await getStatusZip(doc.trackId, send);
      if (status.state === "accepted" || (status.state !== "error" && !notFound(status))) result = status;
      else if (status.state === "error") throw new Error("status_unavailable");
    } else {
      const fresh = await db.supportDocument.findUniqueOrThrow({ where: { id: doc.id } });
      const stored = snapshotOf(fresh.snapshot);
      const { date, time } = dianIssueDateTime(now);
      // La forma de generación depende del día de la FIRMA (DSFC02b/c): se
      // recalcula al armar. Si ya pasaron más de 6 días, la DIAN lo
      // rechazaría: se bloquea con el motivo en vez de gastar un envío.
      const snap: SupportDocSnapshot =
        fresh.kind === "support_document"
          ? { ...stored, lines: stored.lines.map((l) => ({ ...l, generationForm: generationFormFor(l.purchaseDate, date) })) }
          : stored;
      const common = {
        environment: config.envCode,
        softwareId: config.softwareId,
        softwarePin: config.softwarePin,
        documentNumber: fresh.documentNumber,
        issueDate: date,
        issueTime: time,
        customizationId: snap.customizationId,
        seller: snap.seller,
        buyer: snap.buyer,
        lines: snap.lines,
        paymentMeans: snap.paymentMeans,
        note: snap.note,
      };
      const built =
        fresh.kind === "adjustment_note"
          ? buildAdjustmentNoteXml({
              ...common,
              reference: snap.reference!,
              reasonCode: snap.reasonCode!,
              reasonText: snap.reasonText ?? "",
            })
          : buildSupportDocumentXml({ ...common, resolution: snap.resolution ?? config.resolution });
      const signed = signXmlDian(built.xml, config.cert, { signingTime: dianSigningTime(now) });
      // Bytes, CUDS, nombre e instante quedan guardados ANTES de transmitir.
      const prepared = await db.$transaction(async (tx) => {
        const year = Number(date.slice(0, 4));
        const seq = await nextFileSequence(tx, fresh.issuerNit, config.envCode, year);
        const names = supportDocFileNames(fresh.kind as SupportDocKind, fresh.issuerNit, year, seq);
        const bytes = await zipInvoice(names.xmlFileName, signed);
        const saved = await tx.supportDocument.updateMany({
          where: { id: fresh.id, state: "sent" },
          data: {
            xmlZip: new Uint8Array(bytes),
            cuds: built.cuds,
            issuedAt: now,
            submissionFileName: names.xmlFileName,
            snapshot: { ...snap, issueDate: date, issueTime: time } as unknown as Prisma.InputJsonValue,
            ...totalsColumns(snap.lines),
          },
        });
        if (saved.count !== 1) throw new Error("lost_claim");
        return { bytes, zipFileName: names.zipFileName };
      });
      zip = prepared.bytes;
      zipFileName = prepared.zipFileName;
    }

    if (!result) {
      attempts += 1;
      const counted = await db.supportDocument.updateMany({
        where: { id: doc.id, state: "sent" },
        data: { attempts: { increment: 1 }, lastError: null },
      });
      if (counted.count !== 1) throw new Error("lost_claim");
      result =
        config.environment === "habilitacion"
          ? await sendTestSetAsync(zip, config.testSetId!, { ...send, fileName: zipFileName })
          : await sendBillSync(zip, { ...send, fileName: zipFileName });
    }
    await finalize(doc.id, args.restaurantId, result, attempts, now, "sent");
  } catch (err) {
    if (err instanceof SupportDocError) {
      // Bloqueo de configuración: no se mandó nada; vuelve a donde estaba.
      await release({
        state: previous,
        lastError: err.code,
        nextAttemptAt: new Date(now.getTime() + BLOCKED_RETRY_MS),
      });
    } else if (err instanceof Error && err.message === "lost_claim") {
      // Otro proceso tomó el documento: no se toca.
    } else {
      await release({
        state: "error",
        lastError: "transport_error",
        errors: ["transport_error"],
        nextAttemptAt: new Date(now.getTime() + emissionBackoffMs(doc.attempts + 1)),
      });
    }
  }
  return outcome(await db.supportDocument.findUniqueOrThrow({ where: { id: doc.id } }));
}

/** Persiste el resultado de la DIAN y sus efectos (anulación, estado de habilitación). */
async function finalize(
  id: string,
  restaurantId: string,
  result: DianResult,
  attempts: number,
  now: Date,
  fromState: string,
): Promise<void> {
  let state: string = result.state;
  let lastError: string | null = null;
  let nextAttemptAt: Date | null = null;
  let errors = result.errors;
  if (result.state === "rejected") {
    if (isDuplicate(result)) {
      // Ya hay un documento con este número: se consulta por CUDS antes de
      // decidir (puede ser NUESTRO envío anterior, aceptado).
      state = "error";
      lastError = "dian_duplicate";
      nextAttemptAt = new Date(now.getTime() + 2 * 60_000);
    } else if (notFound(result)) {
      state = "pending";
      nextAttemptAt = new Date(now.getTime() + 2 * 60_000);
    } else {
      lastError = result.errors[0] ?? result.statusCode ?? "rejected";
    }
  } else if (result.state === "pending") {
    nextAttemptAt = new Date(now.getTime() + 60_000);
    errors = [];
  } else if (result.state === "error") {
    lastError = result.errors[0] ?? "transport_error";
    nextAttemptAt = attempts < MAX_ATTEMPTS ? new Date(now.getTime() + emissionBackoffMs(attempts)) : null;
  }
  const saved = await db.supportDocument.updateMany({
    where: { id, restaurantId, state: fromState },
    data: {
      state,
      errors,
      lastError,
      nextAttemptAt,
      responseXml: result.raw ?? undefined,
      ...(result.zipKey ? { trackId: result.zipKey } : {}),
    },
  });
  if (saved.count !== 1 || state !== "accepted") return;

  const doc = await db.supportDocument.findUniqueOrThrow({
    where: { id },
    select: { kind: true, reasonCode: true, adjustsId: true, environment: true },
  });
  // Anulación aceptada: el gasto o la compra queda libre para un documento
  // soporte nuevo (corregido).
  if (doc.kind === "adjustment_note" && doc.reasonCode === VOID_REASON && doc.adjustsId) {
    await db.supportDocument.updateMany({ where: { id: doc.adjustsId }, data: { activeKey: null } });
  }
  // Primer documento aceptado en habilitación: el comercio pasa a "en pruebas".
  if (doc.environment === "2") {
    const emisorConfig = await loadConfigIdFor(restaurantId);
    if (emisorConfig) {
      await db.dianConfig.updateMany({
        where: { id: emisorConfig, supportDocStatus: "pending" },
        data: { supportDocStatus: "testing" },
      });
    }
  }
}

async function loadConfigIdFor(restaurantId: string): Promise<string | null> {
  const { resolveEmisor } = await import("@/lib/dian/config");
  const emisor = await resolveEmisor(restaurantId);
  if (!emisor) return null;
  const c = await db.dianConfig.findUnique({
    where: emisor.ref.kind === "legalEntity" ? { legalEntityId: emisor.ref.id } : { restaurantId: emisor.ref.id },
    select: { id: true },
  });
  return c?.id ?? null;
}

// ── Barrido ─────────────────────────────────────────────────────────────────

/**
 * Red de seguridad del cron de la DIAN: consulta los pendientes (el set de
 * pruebas responde asíncrono) y reintenta los errores de canal con backoff.
 * Los rechazados NO: se corrigen y se reenvían a mano.
 */
export async function sweepSupportDocuments(opts: { now?: Date; budgetMs?: number; limit?: number } = {}) {
  const now = opts.now ?? new Date();
  const started = Date.now();
  const due = { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] };
  const docs = await db.supportDocument.findMany({
    where: {
      OR: [
        { state: "pending", ...due },
        { state: "to_send", ...due },
        { state: "error", attempts: { lt: MAX_ATTEMPTS }, ...due },
        { state: "sent", updatedAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) } },
      ],
    },
    orderBy: { updatedAt: "asc" },
    take: opts.limit ?? 50,
    select: { id: true, restaurantId: true, state: true },
  });
  const summary = { checked: 0, accepted: 0, rejected: 0, failed: 0 };
  for (const d of docs) {
    if (opts.budgetMs && Date.now() - started > opts.budgetMs) break;
    summary.checked++;
    try {
      const r =
        d.state === "pending"
          ? await refreshSupportDocumentStatus({ restaurantId: d.restaurantId, id: d.id, now })
          : await transmitSupportDocument({ restaurantId: d.restaurantId, id: d.id, now });
      if (r.state === "accepted") summary.accepted++;
      if (r.state === "rejected") summary.rejected++;
    } catch (err) {
      summary.failed++;
      console.error("[supportDocs] barrido", {
        id: d.id,
        error: err instanceof SupportDocError ? err.code : err instanceof Error ? err.message : String(err),
      });
    }
  }
  return summary;
}
