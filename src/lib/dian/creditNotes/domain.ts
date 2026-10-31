import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CreditNoteInput, CreditNotePreviewInput, CreditNoteProposal, CreditNoteSnapshot, CreditReason, CreditedLine, OriginalCreditLine, RemainingCreditLine } from './types';
import { creditNoteFailure } from '../creditNoteResponse';
export class CreditNoteError extends Error {
    constructor(readonly code: string, readonly status = 409) { super(code); this.name = 'CreditNoteError'; }
}
export const creditNoteInputSchema = z.object({
    originalInvoiceId: z.string().min(1).max(128), requestId: z.string().min(8).max(128), sourceVersion: z.string().regex(/^[a-f0-9]{64}$/),
    mode: z.enum(['total', 'partial']), reasonCode: z.enum(['1', '2', '3', '4', '5', '6']), reasonText: z.string().trim().min(3).max(500),
    lines: z.array(z.object({ lineId: z.string().min(1).max(128), grossCents: z.number().int().positive().max(2147483647) }).strict()).max(500).optional(),
}).strict();
export const creditNotePreviewSchema = creditNoteInputSchema.omit({ requestId: true });
export function sourceVersion(sourceIdentity: string, reservations: Array<{
    id: string;
    [key: string]: unknown;
}>): string {
    return createHash('sha256').update(JSON.stringify([sourceIdentity, [...reservations].sort((a, b) => a.id.localeCompare(b.id))])).digest('hex');
}
export function requestHash(input: CreditNoteInput): string {
    return createHash('sha256').update(JSON.stringify({ ...input, lines: input.mode === 'total' ? undefined : [...(input.lines ?? [])].sort((a, b) => a.lineId.localeCompare(b.lineId)) })).digest('hex');
}
export function remainingLines(original: OriginalCreditLine[], reserved: CreditedLine[]): RemainingCreditLine[] {
    return original.map(line => {
        const allocations = reserved.filter(n => n.originalLineId === line.lineId);
        const reservedGrossCents = allocations.reduce((sum, n) => sum + n.grossCents, 0);
        const reservedTaxCents = allocations.reduce((sum, n) => sum + n.taxCents, 0);
        if (reservedGrossCents > line.grossCents || reservedTaxCents > line.taxCents || reservedGrossCents - reservedTaxCents > line.lineTotalCents)
            throw new CreditNoteError('budget_inconsistent');
        return { ...line, reservedGrossCents, reservedTaxCents, remainingGrossCents: line.grossCents - reservedGrossCents };
    });
}
export function buildProposal(remaining: RemainingCreditLine[], input: CreditNotePreviewInput): CreditNoteProposal {
    if (input.reasonCode === '2' && (input.mode !== 'total' || remaining.some(l => l.reservedGrossCents > 0)))
        throw new CreditNoteError('cancellation_requires_full_invoice');
    const requested = input.mode === 'total' ? remaining.filter(l => l.remainingGrossCents > 0).map(l => ({ lineId: l.lineId, grossCents: l.remainingGrossCents })) : (input.lines ?? []);
    if (!requested.length)
        throw new CreditNoteError('empty_credit');
    const seen = new Set<string>();
    const lines = requested.map(r => {
        const original = remaining.find(l => l.lineId === r.lineId);
        if (!original || seen.has(r.lineId))
            throw new CreditNoteError('invalid_lines', 400);
        seen.add(r.lineId);
        if (!Number.isSafeInteger(r.grossCents) || r.grossCents <= 0 || r.grossCents > original.remainingGrossCents)
            throw new CreditNoteError('amount_exceeds_remaining');
        const taxTarget = Number((BigInt(original.taxCents) * BigInt(original.reservedGrossCents + r.grossCents) * BigInt(2) + BigInt(original.grossCents)) / (BigInt(2) * BigInt(original.grossCents)));
        const remainingTax = original.taxCents - original.reservedTaxCents;
        const remainingBase = original.lineTotalCents - (original.reservedGrossCents - original.reservedTaxCents);
        const taxCents = Math.max(Math.max(0, r.grossCents - remainingBase), Math.min(remainingTax, r.grossCents, taxTarget - original.reservedTaxCents));
        const lineTotalCents = r.grossCents - taxCents;
        if (lineTotalCents <= 0)
            throw new CreditNoteError('amount_too_small', 400);
        return { originalLineId: original.lineId, description: original.description, quantity: 1, unitPriceCents: lineTotalCents, lineTotalCents, taxCents, taxPct: original.taxPct, taxSchemeId: original.taxSchemeId, itemCode: original.itemCode, grossCents: r.grossCents };
    });
    const totalCents = lines.reduce((s, l) => s + l.grossCents, 0);
    if (!Number.isSafeInteger(totalCents) || totalCents > 2147483647)
        throw new CreditNoteError('amount_too_large', 400);
    return { lines, subtotalCents: lines.reduce((s, l) => s + l.lineTotalCents, 0), taxCents: lines.reduce((s, l) => s + l.taxCents, 0), totalCents };
}
/**
 * Descartar = sacar la nota de la lista y liberar la factura. El registro
 * fiscal se conserva y el número nunca se reutiliza. Se puede cuando:
 * - la nota nunca se firmó ni se envió (sin XML, 0 intentos), o
 * - la nota firmada quedó sin salida (`creditNoteFailure`): rechazo
 *   definitivo de la DIAN (IsValid=false + 99, incluido el conflicto de
 *   numeración regla 90) o «No recibida por la DIAN».
 * Un envío incierto (pendiente, enviado, error de canal) NO: la DIAN todavía
 * podría tener la nota como válida.
 */
export function canAbandon(document: {
    state: string;
    xmlZip: unknown;
    attempts: number;
    leaseExpiresAt: Date | null;
    lastError?: string | null;
    responseXml?: string | null;
} | null, abandonedAt: Date | null, now = new Date()): boolean {
    if (abandonedAt || !document || (document.leaseExpiresAt && document.leaseExpiresAt > now))
        return false;
    if (creditNoteFailure(document))
        return true;
    return ['to_send', 'error'].includes(document.state) && document.xmlZip === null && document.attempts === 0;
}
/** Uso de una serie de notas del emisor, para decidir cuál está activa. */
export type CreditNoteSeriesUsage = {
    prefix: string;
    nextNumber: number;
    /** Mayor número de la serie con conflicto de numeración DIAN (descartadas incluidas). */
    maxConflictNumber: number | null;
    /** Mayor número de la serie aceptado por la DIAN. */
    maxAcceptedNumber: number | null;
    lastAcceptedAt: Date | null;
};
/**
 * Una serie está en conflicto si alguna de sus notas recibió el rechazo
 * regla 90 (el número ya lo usó este NIT en otro sistema) y ninguna nota
 * posterior de esa misma serie fue aceptada después.
 */
export function seriesInConflict(series: CreditNoteSeriesUsage): boolean {
    return series.maxConflictNumber !== null && !(series.maxAcceptedNumber !== null && series.maxAcceptedNumber > series.maxConflictNumber);
}
/**
 * Serie activa para una nota nueva:
 * 1. La configurada (`DianConfig.creditNotePrefix`), si no está en conflicto.
 * 2. Si lo está, otra serie del mismo NIT y ambiente, sin conflicto, válida y
 *    con al menos una nota aceptada por la DIAN (probada con ese NIT); entre
 *    varias, la de la aceptación más reciente.
 * 3. Si no hay ninguna, `blocked`: no se emite en una serie que la DIAN ya
 *    rechazó; hay que configurar un prefijo nuevo.
 */
export function chooseCreditNotePrefix(configuredPrefix: string, usage: CreditNoteSeriesUsage[], eligible: (prefix: string) => boolean): {
    prefix: string;
    conflictPrefix: string | null;
    blocked: boolean;
} {
    const configured = usage.find(series => series.prefix === configuredPrefix);
    if (!configured || !seriesInConflict(configured))
        return { prefix: configuredPrefix, conflictPrefix: null, blocked: false };
    const [fallback] = usage
        .filter(series => series.prefix !== configuredPrefix && eligible(series.prefix) && !seriesInConflict(series) && series.maxAcceptedNumber !== null)
        .sort((a, b) => (b.lastAcceptedAt?.getTime() ?? 0) - (a.lastAcceptedAt?.getTime() ?? 0) || a.prefix.localeCompare(b.prefix));
    return fallback
        ? { prefix: fallback.prefix, conflictPrefix: configuredPrefix, blocked: false }
        : { prefix: configuredPrefix, conflictPrefix: configuredPrefix, blocked: true };
}
/** Clave idempotente de la nota de reemplazo: un doble clic no crea dos. */
export const reissueRequestId = (creditNoteId: string) => `reissue:${creditNoteId}`;
/**
 * Misma factura, mismo motivo y explicación, mismos importes por línea que
 * la nota descartada. La anulación (motivo 2) siempre es total.
 */
export function reissueCreditNoteInput(note: {
    id: string;
    originalInvoiceId: string;
    reasonCode: string;
    reasonText: string;
    snapshot: Pick<CreditNoteSnapshot, 'lines'>;
}, sourceVersion: string): CreditNoteInput {
    const input = creditNoteInputSchema.safeParse({
        originalInvoiceId: note.originalInvoiceId,
        requestId: reissueRequestId(note.id),
        sourceVersion,
        reasonCode: note.reasonCode as CreditReason,
        reasonText: note.reasonText,
        ...(note.reasonCode === '2'
            ? { mode: 'total' }
            : { mode: 'partial', lines: note.snapshot.lines.map(line => ({ lineId: line.originalLineId, grossCents: line.grossCents })) }),
    });
    if (!input.success)
        throw new CreditNoteError('source_unsupported');
    return input.data;
}
