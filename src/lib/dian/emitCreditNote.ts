import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { isModuleEnabled } from "@/lib/modules";
import { DianConfigError, loadDianConfig, resolveEmisor } from "./config";
import { buildDianCreditNoteXml, type CreditNoteReasonCode } from "./creditNote";
import type { CreditNoteSnapshot } from "./creditNotes/types";
import { creditNoteDeliveryDecision, creditNoteLeaseWhere, CREDIT_NOTE_LEASE_MS, CREDIT_NOTE_POLL_MS } from "./creditNoteDeliveryState";
import { dianIssueDateTime, dianSigningTime } from "./dianDateTime";
import { signXmlDian } from "./xades";
import { getStatus, getStatusZip, sendBillSync, sendTestSetAsync, type DianResult } from "./soap";
import { prepareCreditNotePayload } from "./creditNotePayload";
import { CreditNoteError } from "./creditNotes/domain";
import { sendDianCreditNoteEmail } from "./sendCreditNoteEmail";
import { BLOCKED_RETRY_MS, emissionBackoffMs } from "./retry";
import { stampCreditNoteAccounting } from "@/lib/erp/creditNoteAccounting";

export type EmitCreditNoteResult = {
  outcome: "not_found" | "already_emitted" | "blocked" | "accepted" | "pending" | "rejected" | "error";
  reason?: string;
  documentId?: string;
  errors?: string[];
};
const notFound = (r: DianResult) => r.statusCode?.trim() === "66" || r.statusCode?.trim() === "90";
// ErrorMessage rule 90 is a duplicate, NOT StatusCode 90 (missing TrackId).
const duplicate = (r: DianResult) => r.errors.some(e => /(?:regla\s*:?\s*90\b|procesad[oa].*anterior|already\s+process)/i.test(e));

/** Persist once, transmit those exact bytes, and recover uncertain sends by CUDE.
 * Every write after the claim compares its lease token; an expired worker can
 * never overwrite another worker's acceptance or release a fiscal reservation.
 */
export async function emitDianCreditNote(opts: {
  creditNoteId: string;
  restaurantId: string;
  now?: Date;
  mode?: "emit" | "status";
}): Promise<EmitCreditNoteResult> {
  const note = await db.creditNote.findFirst({
    where: { id: opts.creditNoteId, restaurantId: opts.restaurantId },
    include: { dianDocument: true, series: true },
  });
  if (!note?.dianDocument) return { outcome: "not_found" };
  const doc = note.dianDocument;
  const now = opts.now ?? new Date();
  const decision = creditNoteDeliveryDecision({ state: doc.state, hasPayload: !!doc.xmlZip, abandoned: !!note.abandonedAt, leaseExpiresAt: doc.leaseExpiresAt }, now);
  if (decision === "skip" || (opts.mode === "status" && !doc.xmlZip)) return { outcome: "already_emitted" };
  const leaseToken = randomUUID();
  const claim = await db.dianDocument.updateMany({
    where: {
      ...creditNoteLeaseWhere(doc.id, opts.restaurantId, now),
      // A different worker may finish between our read and this claim. In
      // particular, a stale null ZIP must never overwrite its signed payload.
      updatedAt: doc.updatedAt,
      state: doc.state,
      cufe: doc.cufe,
      xmlZip: doc.xmlZip ? { not: null } : null,
      attempts: doc.attempts,
    },
    data: { leaseToken, leaseExpiresAt: new Date(now.getTime() + CREDIT_NOTE_LEASE_MS) },
  });
  if (claim.count !== 1) return { outcome: "already_emitted" };
  const owned = { id: doc.id, restaurantId: opts.restaurantId, kind: "credit_note", leaseToken, creditNote: { is: { abandonedAt: null } } };
  const persist = (data: Prisma.DianDocumentUpdateManyMutationInput) => db.dianDocument.updateMany({ where: owned, data });
  const release = (data: Prisma.DianDocumentUpdateManyMutationInput) => persist({ ...data, leaseToken: null, leaseExpiresAt: null });
  const blocked = async (reason: string): Promise<EmitCreditNoteResult> => {
    const saved = await release({ state: doc.xmlZip ? "error" : "to_send", lastError: reason, errors: [reason], nextAttemptAt: new Date(now.getTime() + BLOCKED_RETRY_MS) });
    return saved.count === 1 ? { outcome: "blocked", reason, documentId: doc.id } : { outcome: "already_emitted" };
  };
  let attempts = doc.attempts;
  try {
    const restaurant = await db.restaurant.findUnique({ where: { id: opts.restaurantId }, select: { enabledModules: true } });
    if (!restaurant || !isModuleEnabled(restaurant.enabledModules, "einvoicing")) return blocked("module_disabled");
    const snapshot = note.snapshot as unknown as CreditNoteSnapshot;
    if (snapshot.version !== 1 || !snapshot.lines?.length) return blocked("source_unsupported");
    const original = snapshot.original;
    const emisor = await resolveEmisor(opts.restaurantId);
    // The snapshot remains authoritative even if the restaurant edits its name,
    // address, customers, rates or menu after issuing the original invoice.
    const currentNit = emisor?.taxId?.split("-")[0].replace(/\D/g, "");
    if (currentNit !== original.supplier.companyId || note.series.issuerNit !== original.supplier.companyId) return blocked("issuer_changed");
    const config = await loadDianConfig(opts.restaurantId, { requireTechnicalKey: false });
    if ((config.environment === "produccion" ? "1" : "2") !== original.environment || note.series.environment !== original.environment) return blocked("environment_changed");
    if (config.cert.notBefore > now || config.cert.notAfter <= now) return blocked("certificate_expired");
    if (config.environment === "habilitacion" && !config.testSetId && !doc.xmlZip) return blocked("test_set_missing");
    const args = { environment: config.environment, cert: config.cert };
    let zip: Buffer;
    let zipFileName = doc.submissionFileName?.replace(/^nc/, "z").replace(/\.xml$/i, ".zip");
    let cude = doc.cufe;
    let result: DianResult | null = null;
    if (doc.xmlZip) {
      if (!cude || !doc.issuedAt) return blocked("incomplete_document");
      zip = Buffer.from(doc.xmlZip);
      result = await getStatus(cude, args);
      if (notFound(result) && doc.trackId) result = await getStatusZip(doc.trackId, args);
      if (notFound(result)) {
        result = opts.mode === "status" ? { ...result, state: "pending", errors: [] } : null;
      }
    } else {
      const instant = dianIssueDateTime(now);
      const built = buildDianCreditNoteXml({
        environment: original.environment,
        invoiceNumber: note.documentNumber,
        prefix: note.series.prefix,
        issueDate: instant.date,
        issueTime: instant.time,
        softwareId: config.softwareId,
        softwarePin: config.softwarePin,
        supplier: original.supplier,
        customer: original.customer,
        lines: snapshot.lines,
        reference: { invoiceNumber: original.invoiceNumber, cufe: original.cufe, issueDate: original.issueDate },
        discrepancyCode: note.reasonCode as CreditNoteReasonCode,
        discrepancyDescription: note.reasonText,
        paymentMeansCode: original.paymentMeansCode,
        paymentMeansId: original.paymentMeansId,
        paymentDueDate: original.paymentDueDate,
      });
      if (built.totals.payableCents !== note.totalCents || built.totals.lineExtensionCents !== note.subtotalCents || built.totals.taxIvaCents + built.totals.taxIncCents + built.totals.taxIcaCents !== note.taxCents) return blocked("source_unsupported");
      const xml = signXmlDian(built.xml, config.cert, { signingTime: dianSigningTime(now) });
      cude = built.cufe;
      // Filename counter and signed bytes commit together: a crash cannot
      // consume another file sequence or change the year on recovery.
      const prepared = await prepareCreditNotePayload({
        documentId: doc.id, restaurantId: opts.restaurantId, leaseToken,
        issuerNit: original.supplier.companyId, environment: original.environment,
        issuedAt: now, cude, signedXml: xml,
      });
      if (!prepared) return { outcome: "already_emitted" };
      zip = prepared.zip;
      zipFileName = prepared.zipFileName;
    }
    if (!result) {
      if (config.environment === "habilitacion" && !config.testSetId) return blocked("test_set_missing");
      attempts++;
      if ((await persist({ state: "sent", attempts: { increment: 1 }, lastError: null })).count !== 1) return { outcome: "already_emitted" };
      result = config.environment === "habilitacion"
        ? await sendTestSetAsync(zip, config.testSetId!, { ...args, fileName: zipFileName })
        : await sendBillSync(zip, { ...args, fileName: zipFileName });
    }
    if (result.cufe && result.cufe.toLowerCase() !== cude?.toLowerCase()) {
      result = { ...result, state: "error", errors: ["response_identifier_mismatch"] };
    } else if (duplicate(result) || (result.state === "rejected" && notFound(result))) {
      result = { ...result, state: "pending" };
    } else if (result.state === "rejected" && result.statusCode?.trim() !== "99") {
      // Unknown transport/service status must never make a note abandonable.
      result = { ...result, state: "error" };
    }
    const delay = result.state === "error" ? emissionBackoffMs(attempts) : CREDIT_NOTE_POLL_MS;
    const updated = await release({
      state: result.state,
      errors: result.errors,
      lastError: result.state === "error" ? result.errors[0] ?? "transport_error" : null,
      responseXml: result.raw ?? undefined,
      trackId: result.zipKey ?? doc.trackId,
      nextAttemptAt: result.state === "accepted" || result.state === "rejected" ? null : new Date(now.getTime() + delay),
    });
    if (updated.count !== 1) return { outcome: "already_emitted" };
    if (result.state === "accepted") {
      // Contabilidad: fija la parte que cancela cartera de cliente y baja esa
      // deuda (erp/creditNoteAccounting). Un fallo acá no deshace la
      // aceptación fiscal: el motor contable reintenta al generar el diario.
      await stampCreditNoteAccounting(opts.restaurantId, note.id).catch((error) =>
        console.error("[creditNotes] contabilización pendiente tras la aceptación", {
          creditNoteId: note.id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      // Delivery errors cannot roll back fiscal acceptance.
      await sendDianCreditNoteEmail(note.id, opts.restaurantId).catch(() => undefined);
    }
    return { outcome: result.state, documentId: doc.id, errors: result.errors };
  } catch (error) {
    if (error instanceof DianConfigError) return blocked(error.code);
    if (error instanceof CreditNoteError) return blocked(error.code);
    const saved = await release({ state: "error", lastError: "transport_error", errors: ["transport_error"], nextAttemptAt: new Date(now.getTime() + emissionBackoffMs(attempts)) });
    return saved.count === 1 ? { outcome: "error", documentId: doc.id, errors: ["transport_error"] } : { outcome: "already_emitted" };
  }
}
