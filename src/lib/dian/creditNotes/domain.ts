import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CreditNoteInput, CreditNotePreviewInput, CreditNoteProposal, CreditedLine, OriginalCreditLine, RemainingCreditLine } from './types';
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
export function canAbandon(document: {
    state: string;
    xmlZip: unknown;
    attempts: number;
    leaseExpiresAt: Date | null;
} | null, abandonedAt: Date | null, now = new Date()): boolean {
    if (abandonedAt || !document || (document.leaseExpiresAt && document.leaseExpiresAt > now))
        return false;
    return document.state === 'rejected' || (['to_send', 'error'].includes(document.state) && document.xmlZip === null && document.attempts === 0);
}
