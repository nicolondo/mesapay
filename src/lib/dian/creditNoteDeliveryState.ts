/** Fiscal payloads are immutable. Recover uncertain sends by CUDE first. */
export const CREDIT_NOTE_LEASE_MS = 15 * 60_000;
export const CREDIT_NOTE_POLL_MS = 60_000;

/** Rechazo DIAN confirmado: ese número ya lo usó este NIT en otro documento. */
export const CREDIT_NOTE_NUMBERING_CONFLICT = 'dian_numbering_conflict';
/** La DIAN responde de forma consistente que no tiene registro de la nota. */
export const CREDIT_NOTE_NOT_RECEIVED = 'dian_not_received';
/**
 * Umbral de «No recibida por la DIAN». Una nota firmada pasa a ese estado
 * sólo si la consulta de estado (GetStatus por CUDE, o GetStatusZip con un
 * ZipKey) devolvió «no encontrado» (66/90) al menos NOT_RECEIVED_MIN_LOOKUPS
 * veces seguidas —sin ninguna otra respuesta de la DIAN en el medio— y ya
 * pasaron NOT_RECEIVED_MIN_AGE_MS desde la emisión firmada (`issuedAt`).
 * SendBillSync es síncrono: un documento que la DIAN validó aparece en la
 * consulta en segundos, no en un día. Un fallo de canal no suma ni resetea.
 */
export const NOT_RECEIVED_MIN_LOOKUPS = 3;
export const NOT_RECEIVED_MIN_AGE_MS = 24 * 60 * 60_000;
/** `lastError` que sacan una nota del barrido automático (nextAttemptAt null ≠ vencida). */
export const CREDIT_NOTE_SWEEP_STOP_ERRORS = [CREDIT_NOTE_NUMBERING_CONFLICT, CREDIT_NOTE_NOT_RECEIVED] as const;

export function isCreditNoteIdentityError(code: string | null | undefined): code is 'dian_numbering_conflict' | 'response_identifier_mismatch' {
  return code === 'dian_numbering_conflict' || code === 'response_identifier_mismatch';
}

export function stopsCreditNoteSweep(code: string | null | undefined): boolean {
  return (CREDIT_NOTE_SWEEP_STOP_ERRORS as readonly string[]).includes(code ?? '');
}

/** ¿Alcanzó la nota el umbral de «No recibida por la DIAN»? */
export function isNotReceivedByDian(document: { notFoundCount: number; issuedAt: Date | null }, now: Date): boolean {
  return !!document.issuedAt
    && document.notFoundCount >= NOT_RECEIVED_MIN_LOOKUPS
    && now.getTime() - document.issuedAt.getTime() >= NOT_RECEIVED_MIN_AGE_MS;
}

export function creditNoteDeliveryDecision(
  note: {
    state: string;
    hasPayload: boolean;
    abandoned: boolean;
    leaseExpiresAt: Date | null;
  },
  now: Date,
): "prepare" | "lookup" | "skip" {
  if (note.abandoned || (note.leaseExpiresAt && note.leaseExpiresAt > now)) return "skip";
  if (!["to_send", "sent", "error", "pending"].includes(note.state)) return "skip";
  if (note.hasPayload) return "lookup";
  return note.state === "pending" ? "skip" : "prepare";
}

export function creditNoteLeaseWhere(id: string, restaurantId: string, now: Date) {
  return {
    id,
    restaurantId,
    kind: "credit_note",
    state: { in: ["to_send", "error", "sent", "pending"] },
    creditNote: { is: { abandonedAt: null } },
    OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
  };
}
