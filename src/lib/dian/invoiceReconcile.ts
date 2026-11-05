// «Consultar en la DIAN»: averiguar por CUFE si la DIAN ya tiene una
// factura que nosotros no tenemos como aceptada.
//
// El caso que lo motiva es la regla 90 («Documento procesado
// anteriormente»): un envío salió, la DIAN lo aceptó, la respuesta se
// perdió (timeout) y el reintento —con fecha y CUFE nuevos, mismo número—
// chocó contra el aceptado. Ese documento NO está rechazado: está en la
// DIAN. Marcarlo rechazado dejaba la venta sin factura válida a la vista y
// empujaba a reenviarlo, que sólo repite la regla 90.
//
// Cómo se consulta: `GetStatus` con el CUFE como trackId — es lo que la
// DIAN usa como clave de un envío síncrono (SendBillSync no devuelve
// ZipKey; ver `emitCreditNote.ts`, que consulta las notas igual). El
// `trackId` de estos documentos está vacío, así que se prueba con los
// CUFE que conocemos: el guardado (que en una respuesta de regla 90 es el
// `XmlDocumentKey` que devolvió la DIAN), el del XML que guardamos, las
// claves de la respuesta guardada y, opcionalmente, uno que el admin copió
// del portal de la DIAN. Una aceptación sólo vale si el acuse referencia
// ESTE número de factura.
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { DianConfigError, documentErrors, loadDianConfig, type LoadedDianConfig } from "@/lib/dian/config";
import { dianQrUrl } from "@/lib/dian/crypto";
import {
  extractApplicationResponse,
  getStatus,
  getXmlByDocumentKey,
  parseDianResponse,
  unzipFirstXml,
  zipInvoice,
  type DianResult,
  type SendArgs,
} from "@/lib/dian/soap";
import {
  classifyInvoiceResponse,
  dianRejectionCause,
  DUPLICATE_UNVERIFIED,
  isCufe,
} from "@/lib/dian/invoiceResponse";
import { afterInvoiceAccepted, shouldAutoPrintRecovered } from "@/lib/dian/invoiceAcceptance";
import { formatInvoiceNumber, type InvoiceSnapshot } from "@/lib/invoice";
import { applicationResponseReference, invoiceXmlIdentity } from "@/lib/dian/invoiceXml";

/** Cuántos CUFE se prueban como mucho por consulta (cada uno es un GetStatus). */
export const MAX_CUFE_CANDIDATES = 4;

/** Tope de consultas automáticas (barrido) de una factura sin confirmar. */
export const MAX_VERIFY_CHECKS = 6;

/** Espera entre consultas automáticas: 10 min × 2^(n−1), tope 6 h. */
export function verifyBackoffMs(checks: number): number {
  const n = Math.max(1, checks);
  return Math.min(6 * 60 * 60_000, 10 * 60_000 * 2 ** (n - 1));
}

const sameKey = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/** CUFE únicos y bien formados, en orden, con tope. */
export function uniqueCufes(values: ReadonlyArray<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const v of values) {
    if (!isCufe(v)) continue;
    const k = v.trim().toLowerCase();
    if (!out.includes(k)) out.push(k);
  }
  return out.slice(0, MAX_CUFE_CANDIDATES);
}

/**
 * Los CUFE que conocemos de un documento, del más probable al menos: el
 * guardado, el `XmlDocumentKey` y la referencia del acuse de la última
 * respuesta, y el del XML que guardamos.
 */
export async function storedCufeCandidates(doc: {
  cufe: string | null;
  responseXml: string | null;
  xmlZip: Uint8Array | Buffer | null;
}): Promise<string[]> {
  const fromResponse = doc.responseXml ? parseDianResponse(doc.responseXml).cufe : null;
  const ar = applicationResponseReference(await extractApplicationResponse(doc.responseXml));
  const xml = doc.xmlZip ? await unzipFirstXml(doc.xmlZip) : null;
  return uniqueCufes([doc.cufe, fromResponse, ar?.cufe, xml ? invoiceXmlIdentity(xml).cufe : null]);
}

// ── Consulta (red) ────────────────────────────────────────────────────────

export type CufeLookup =
  | { kind: "accepted"; cufe: string; result: DianResult; warnings: string[] }
  /** La DIAN contestó por todos y ninguno está aceptado para este número. */
  | { kind: "not_found"; checked: string[] }
  /** Al menos una consulta no tuvo respuesta: no se sabe. */
  | { kind: "channel_error"; checked: string[]; errors: string[] };

/**
 * Pregunta a la DIAN por cada CUFE hasta encontrar uno ACEPTADO para este
 * número de factura. Una aceptación cuyo acuse nombra OTRO número no
 * cuenta (sería la factura de otra venta). `requireReference`: CUFE que
 * sólo valen si el acuse trae la referencia —los que no salieron de
 * nuestros propios datos, como el que copia el admin del portal—.
 */
export async function findAcceptedInvoiceByCufe(opts: {
  candidates: string[];
  invoiceNumber: string;
  args: SendArgs;
  requireReference?: readonly string[];
}): Promise<CufeLookup> {
  const checked: string[] = [];
  const channelErrors: string[] = [];
  for (const cufe of uniqueCufes(opts.candidates)) {
    checked.push(cufe);
    const result = await getStatus(cufe, opts.args);
    const verdict = classifyInvoiceResponse(result);
    if (verdict.kind === "channel_error") {
      channelErrors.push(...result.errors);
      continue;
    }
    if (verdict.kind !== "accepted") continue;
    if (result.cufe && !sameKey(result.cufe, cufe)) continue;
    const ref = applicationResponseReference(await extractApplicationResponse(result.raw));
    if (ref?.number && ref.number !== opts.invoiceNumber) continue;
    if (ref?.cufe && !sameKey(ref.cufe, cufe)) continue;
    if (opts.requireReference?.some((c) => sameKey(c, cufe)) && ref?.number !== opts.invoiceNumber) {
      continue;
    }
    return { kind: "accepted", cufe, result, warnings: verdict.warnings };
  }
  return channelErrors.length > 0
    ? { kind: "channel_error", checked, errors: channelErrors }
    : { kind: "not_found", checked };
}

/**
 * El XML firmado de la factura aceptada. Si alguno de los que tenemos es
 * de ese CUFE, ése; si no, se le pide a la DIAN (`GetXmlByDocumentKey`) y
 * sólo se usa si es de este número y este CUFE. `write`: lo que hay que
 * guardar en `xmlZip` (null ⇒ dejar lo que está — ya es el correcto, o no
 * hay uno mejor; el correo no adjunta un XML de otro CUFE, ver
 * `sendInvoiceEmail.ts`).
 */
export async function acceptedInvoiceZip(opts: {
  cufe: string;
  invoiceNumber: string;
  known: ReadonlyArray<{ zip: Uint8Array | Buffer; persisted: boolean }>;
  args: SendArgs;
}): Promise<{
  write: Buffer | Uint8Array | null;
  /** El zip del XML de ese CUFE (guardado o traído), o null si no hay. */
  matched: Buffer | Uint8Array | null;
  source: "stored" | "dian" | "none";
}> {
  for (const k of opts.known) {
    const xml = await unzipFirstXml(k.zip);
    if (xml && sameKey(invoiceXmlIdentity(xml).cufe, opts.cufe)) {
      return { write: k.persisted ? null : k.zip, matched: k.zip, source: "stored" };
    }
  }
  const fetched = await getXmlByDocumentKey(opts.cufe, opts.args);
  if (fetched) {
    const id = invoiceXmlIdentity(fetched);
    if (sameKey(id.cufe, opts.cufe) && id.number === opts.invoiceNumber) {
      const zip = await zipInvoice(`${opts.invoiceNumber}.xml`, fetched);
      return { write: zip, matched: zip, source: "dian" };
    }
  }
  return { write: null, matched: null, source: "none" };
}

// ── Persistencia ──────────────────────────────────────────────────────────

export type ClaimedInvoice = {
  documentId: string;
  restaurantId: string;
  simpleInvoiceId: string;
  orderId: string | null;
  invoiceNumber: string;
  /** Verificaciones automáticas sin respuesta positiva hasta ahora. */
  notFoundCount: number;
};

export type ResolveOutcome =
  | { outcome: "accepted"; documentId: string; cufe: string; qrUrl: string; warnings: string[] }
  | { outcome: "unverified"; documentId: string; cufe: string | null; channelError: boolean };

/**
 * Deja ACEPTADA una factura reclamada (`state: sent`) que la DIAN confirmó
 * por CUFE, con el XML firmado de ESE CUFE si lo tenemos o lo devuelve la
 * DIAN, y corre los efectos de la aceptación.
 */
export async function persistAcceptedInvoice(opts: {
  doc: ClaimedInvoice;
  lookup: Extract<CufeLookup, { kind: "accepted" }>;
  knownZips: ReadonlyArray<{ zip: Uint8Array | Buffer; persisted: boolean }>;
  config: LoadedDianConfig;
  now: Date;
  print: boolean;
  extra?: Prisma.DianDocumentUpdateInput;
}): Promise<Extract<ResolveOutcome, { outcome: "accepted" }>> {
  const { doc, lookup, config, now } = opts;
  const args: SendArgs = { environment: config.environment, cert: config.cert };
  const env: "1" | "2" = config.environment === "produccion" ? "1" : "2";
  const zip = await acceptedInvoiceZip({
    cufe: lookup.cufe,
    invoiceNumber: doc.invoiceNumber,
    known: opts.knownZips,
    args,
  });
  await db.dianDocument.update({
    where: { id: doc.documentId },
    data: {
      ...opts.extra,
      state: "accepted",
      cufe: lookup.cufe,
      // El acuse de la consulta: de ahí sale el AttachedDocument.
      responseXml: lookup.result.raw ?? null,
      errors: [],
      warnings: lookup.warnings.length ? lookup.warnings : undefined,
      lastError: null,
      nextAttemptAt: null,
      statusNotFoundCount: 0,
      ...(zip.write ? { xmlZip: new Uint8Array(zip.write) } : {}),
    },
  });
  if (zip.source === "none") {
    console.warn("[dian-reconcile] aceptada sin el XML firmado de ese CUFE", {
      documentId: doc.documentId,
    });
  }
  await afterInvoiceAccepted({
    documentId: doc.documentId,
    simpleInvoiceId: doc.simpleInvoiceId,
    restaurantId: doc.restaurantId,
    orderId: doc.orderId,
    cufe: lookup.cufe,
    environment: config.environment,
    closure: { rail: "status", xmlZip: zip.matched, now },
    print: opts.print,
  });
  return {
    outcome: "accepted",
    documentId: doc.documentId,
    cufe: lookup.cufe,
    qrUrl: dianQrUrl(lookup.cufe, env),
    warnings: lookup.warnings,
  };
}

/**
 * Con el documento YA reclamado (`state: sent`), consulta los candidatos y
 * persiste: aceptada (con sus efectos) o `pending` + DUPLICATE_UNVERIFIED
 * con la próxima consulta automática. `extra`: lo que el caller suma al
 * mismo update (el intento contado…); `extraIfUnverified`, lo que sólo se
 * escribe si queda sin confirmar (la respuesta de la regla 90, el XML…).
 */
export async function resolveClaimedInvoice(opts: {
  doc: ClaimedInvoice;
  candidates: ReadonlyArray<string | null | undefined>;
  requireReference?: string[];
  knownZips: ReadonlyArray<{ zip: Uint8Array | Buffer; persisted: boolean }>;
  config: LoadedDianConfig;
  now: Date;
  print: boolean;
  extra?: Prisma.DianDocumentUpdateInput;
  extraIfUnverified?: Prisma.DianDocumentUpdateInput;
}): Promise<ResolveOutcome> {
  const { doc, config, now } = opts;
  const candidates = uniqueCufes(opts.candidates);
  const lookup = await findAcceptedInvoiceByCufe({
    candidates,
    invoiceNumber: doc.invoiceNumber,
    args: { environment: config.environment, cert: config.cert },
    requireReference: opts.requireReference,
  });
  if (lookup.kind === "accepted") {
    return persistAcceptedInvoice({
      doc,
      lookup,
      knownZips: opts.knownZips,
      config,
      now,
      print: opts.print,
      extra: opts.extra,
    });
  }

  // Sin confirmar. Un fallo de canal no cuenta como «no la encontró».
  const channelError = lookup.kind === "channel_error";
  const checks = channelError ? doc.notFoundCount : doc.notFoundCount + 1;
  const best = candidates[0] ?? null;
  await db.dianDocument.update({
    where: { id: doc.documentId },
    data: {
      ...opts.extra,
      ...opts.extraIfUnverified,
      state: "pending",
      lastError: DUPLICATE_UNVERIFIED,
      ...(best ? { cufe: best } : {}),
      statusNotFoundCount: checks,
      nextAttemptAt:
        checks >= MAX_VERIFY_CHECKS ? null : new Date(now.getTime() + verifyBackoffMs(Math.max(1, checks))),
    },
  });
  return { outcome: "unverified", documentId: doc.documentId, cufe: best, channelError };
}

// ── «Consultar en la DIAN» ────────────────────────────────────────────────

export type InvoiceStatusCheckResult =
  /** No existe, es de otro comercio o no es una factura de venta con tirilla. */
  | { outcome: "not_found" }
  /** Ya aceptada, en vuelo, o en un estado que no se consulta. */
  | { outcome: "not_applicable"; state: string }
  /** No hay ningún CUFE con qué preguntar. */
  | { outcome: "no_cufe" }
  /** La configuración DIAN del comercio no permite consultar. */
  | { outcome: "blocked"; reason: DianConfigError["code"] }
  | ResolveOutcome;

/** Estados desde los que se puede consultar por CUFE. */
export const CHECKABLE_WHERE = (id: string): Prisma.DianDocumentWhereInput => ({
  id,
  kind: "invoice",
  OR: [
    { state: { in: ["rejected", "error"] } },
    { state: "pending", lastError: DUPLICATE_UNVERIFIED },
  ],
});

/**
 * Consulta por CUFE una factura rechazada, con error o sin confirmar, y la
 * deja aceptada si la DIAN la tiene. La reclama antes (`sent`, el mismo
 * cerrojo de la emisión) para que un reenvío o el barrido no la toquen a
 * la vez. Idempotente: una aceptada devuelve `not_applicable`.
 */
export async function checkDianInvoiceStatus(opts: {
  documentId: string;
  restaurantId: string;
  now?: Date;
  /** CUFE adicional (p. ej. copiado del portal de la DIAN). Sólo vale con acuse que lo confirme. */
  extraCufe?: string | null;
  /** Default: sólo si la factura es reciente (`shouldAutoPrintRecovered`). */
  print?: boolean;
  config?: LoadedDianConfig;
}): Promise<InvoiceStatusCheckResult> {
  const now = opts.now ?? new Date();
  const doc = await db.dianDocument.findUnique({
    where: { id: opts.documentId },
    select: {
      id: true,
      restaurantId: true,
      kind: true,
      state: true,
      cufe: true,
      xmlZip: true,
      responseXml: true,
      lastError: true,
      errors: true,
      updatedAt: true,
      statusNotFoundCount: true,
      simpleInvoice: {
        select: { id: true, orderId: true, invoiceNumber: true, snapshot: true, createdAt: true },
      },
    },
  });
  if (!doc || doc.restaurantId !== opts.restaurantId || doc.kind !== "invoice" || !doc.simpleInvoice) {
    return { outcome: "not_found" };
  }
  // Sólo lo que la DIAN dijo tener (regla 90) o lo que ya quedó sin
  // confirmar. Un error de canal o un rechazo real NO se consulta acá: si
  // la DIAN no lo tiene hay que reenviarlo, y eso lo hace la emisión (que
  // además pregunta por el CUFE anterior antes de mandar uno nuevo).
  const checkable =
    (doc.state === "pending" && doc.lastError === DUPLICATE_UNVERIFIED) ||
    ((doc.state === "rejected" || doc.state === "error") &&
      dianRejectionCause({ lastError: doc.lastError, errors: documentErrors(doc.errors) }) === "already_at_dian");
  if (!checkable) return { outcome: "not_applicable", state: doc.state };

  const extra = isCufe(opts.extraCufe) ? opts.extraCufe.trim().toLowerCase() : null;
  // El que trae el admin va primero: es el que vino a probar.
  const candidates = uniqueCufes([extra, ...(await storedCufeCandidates(doc))]);
  if (candidates.length === 0) return { outcome: "no_cufe" };

  let config = opts.config;
  if (!config) {
    try {
      config = await loadDianConfig(opts.restaurantId);
    } catch (err) {
      if (err instanceof DianConfigError) return { outcome: "blocked", reason: err.code };
      throw err;
    }
  }

  // Cerrojo: sólo si nadie la tocó desde que la leímos.
  const claimed = await db.dianDocument.updateMany({
    where: { ...CHECKABLE_WHERE(doc.id), updatedAt: doc.updatedAt },
    data: { state: "sent" },
  });
  if (claimed.count === 0) return { outcome: "not_applicable", state: "sent" };

  const snap = doc.simpleInvoice.snapshot as unknown as InvoiceSnapshot;
  try {
    return await resolveClaimedInvoice({
      doc: {
        documentId: doc.id,
        restaurantId: doc.restaurantId,
        simpleInvoiceId: doc.simpleInvoice.id,
        orderId: doc.simpleInvoice.orderId,
        invoiceNumber: formatInvoiceNumber(snap, doc.simpleInvoice.invoiceNumber),
        notFoundCount: doc.statusNotFoundCount ?? 0,
      },
      candidates,
      requireReference: extra ? [extra] : [],
      knownZips: doc.xmlZip ? [{ zip: doc.xmlZip, persisted: true }] : [],
      config,
      now,
      print: opts.print ?? shouldAutoPrintRecovered(doc.simpleInvoice.createdAt, now),
    });
  } catch (err) {
    // Nada de reclamos eternos: vuelve a quedar consultable.
    await db.dianDocument.update({
      where: { id: doc.id },
      data: { state: "pending", lastError: DUPLICATE_UNVERIFIED, nextAttemptAt: new Date(now.getTime() + verifyBackoffMs(1)) },
    });
    throw err;
  }
}

// ── Barrido de las sin confirmar ──────────────────────────────────────────

/** Cuántas facturas sin confirmar se consultan por barrido como mucho. */
export const VERIFY_SWEEP_LIMIT = 10;

/**
 * Vuelve a consultar por CUFE las facturas que la DIAN dijo tener (regla
 * 90) y todavía no confirmamos, con su backoff (`nextAttemptAt`) y su tope
 * (`MAX_VERIFY_CHECKS`: después queda quieta, visible para una persona).
 * Lo corre el mismo cron que la emisión. Secuencial y con presupuesto.
 */
export async function sweepUnverifiedInvoices(opts: {
  now?: Date;
  budgetMs?: number;
  limit?: number;
} = {}): Promise<{ scanned: number; accepted: number; unverified: number; skipped: number }> {
  const now = opts.now ?? new Date();
  const startedAt = Date.now();
  const budget = opts.budgetMs ?? 10_000;
  const docs = await db.dianDocument.findMany({
    where: {
      kind: "invoice",
      state: "pending",
      lastError: DUPLICATE_UNVERIFIED,
      simpleInvoiceId: { not: null },
      nextAttemptAt: { lte: now },
    },
    orderBy: { nextAttemptAt: "asc" },
    take: opts.limit ?? VERIFY_SWEEP_LIMIT,
    select: { id: true, restaurantId: true },
  });
  const out = { scanned: 0, accepted: 0, unverified: 0, skipped: 0 };
  for (const d of docs) {
    if (Date.now() - startedAt > budget) break;
    out.scanned++;
    try {
      const r = await checkDianInvoiceStatus({ documentId: d.id, restaurantId: d.restaurantId, now });
      if (r.outcome === "accepted") out.accepted++;
      else if (r.outcome === "unverified") out.unverified++;
      else out.skipped++;
    } catch (err) {
      out.skipped++;
      console.error("[dian-reconcile] barrido", d.id, err);
    }
  }
  return out;
}
