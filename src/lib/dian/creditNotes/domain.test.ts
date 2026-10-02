import { describe, expect, it } from 'vitest';
import { buildProposal, remainingLines, sourceVersion, CreditNoteError } from './domain';
import type { OriginalCreditLine, CreditNoteInput } from './types';
const line: OriginalCreditLine = { lineId: '1', description: 'Test', quantity: 2, unitPriceCents: 50, lineTotalCents: 100, taxCents: 19, taxPct: '19.00', taxSchemeId: '01', grossCents: 119 };
const input: CreditNoteInput = { originalInvoiceId: 'i', requestId: 'r', sourceVersion: 'v', mode: 'partial', reasonCode: '3', reasonText: 'Discount', lines: [{ lineId: '1', grossCents: 40 }] };
describe('credit fiscal budget', () => {
    it('conserves cents over multiple partial credits', () => {
        const a = buildProposal(remainingLines([line], []), input);
        const b = buildProposal(remainingLines([line], a.lines), input);
        const c = buildProposal(remainingLines([line], [...a.lines, ...b.lines]), { ...input, mode: 'total' });
        expect(a.totalCents + b.totalCents + c.totalCents).toBe(119);
        expect(a.taxCents + b.taxCents + c.taxCents).toBe(19);
        expect(c.totalCents).toBe(39);
    });
    it('does not allow cancellation after a prior reservation', () => {
        const a = buildProposal(remainingLines([line], []), input);
        expect(() => buildProposal(remainingLines([line], a.lines), { ...input, reasonCode: '2', mode: 'total' })).toThrow('cancellation_requires_full_invoice');
    });
    it.each([0, -1, 0.5, 120, Number.MAX_SAFE_INTEGER])('rejects invalid or excessive amount %s', grossCents => {
        expect(() => buildProposal(remainingLines([line], []), { ...input, lines: [{ lineId: '1', grossCents }] })).toThrow(CreditNoteError);
    });
    it('rejects duplicate and unknown source lines', () => {
        expect(() => buildProposal(remainingLines([line], []), { ...input, lines: [...input.lines!, ...input.lines!] })).toThrow();
        expect(() => buildProposal(remainingLines([line], []), { ...input, lines: [{ lineId: '2', grossCents: 1 }] })).toThrow();
    });
    it('clamps allocation after abandonment without exceeding original tax or base', () => {
        const prior = { ...line, originalLineId: '1', quantity: 1, grossCents: 1, taxCents: 1, lineTotalCents: 0 };
        const p = buildProposal(remainingLines([line], [prior]), { ...input, mode: 'total' });
        expect(p).toMatchObject({ totalCents: 118, taxCents: 18, subtotalCents: 100 });
    });
    it('versions include reservations but are deterministic across read order', () => {
        expect(sourceVersion('a', [{ id: '2', totalCents: 2 }, { id: '1', totalCents: 1 }])).toBe(sourceVersion('a', [{ id: '1', totalCents: 1 }, { id: '2', totalCents: 2 }]));
        expect(sourceVersion('a', [])).not.toBe(sourceVersion('b', []));
    });
});
describe('abandonment guards', () => {
    it('never releases signed or possibly sent fiscal reservations', async () => {
        const { canAbandon } = await import('./domain');
        for (const state of ['accepted', 'pending', 'sent', 'abandoned'])
            expect(canAbandon({ state, xmlZip: null, attempts: 0, leaseExpiresAt: null }, null)).toBe(false);
        expect(canAbandon({ state: 'error', xmlZip: new Uint8Array([1]), attempts: 0, leaseExpiresAt: null }, null)).toBe(false);
        expect(canAbandon({ state: 'error', xmlZip: null, attempts: 1, leaseExpiresAt: null }, null)).toBe(false);
        expect(canAbandon({ state: 'to_send', xmlZip: null, attempts: 0, leaseExpiresAt: new Date(Date.now() + 60000) }, null)).toBe(false);
        expect(canAbandon({ state: 'rejected', xmlZip: new Uint8Array([1]), attempts: 1, leaseExpiresAt: null }, null)).toBe(true);
        expect(canAbandon({ state: 'to_send', xmlZip: null, attempts: 0, leaseExpiresAt: null }, new Date())).toBe(false);
    });
    it('rejects a tax-only one-cent adjustment rather than shifting original tax', () => {
        const rounded = { ...line, lineTotalCents: 3, taxCents: 1, grossCents: 4 };
        const first = buildProposal(remainingLines([rounded], []), { ...input, lines: [{ lineId: '1', grossCents: 1 }] });
        expect(() => buildProposal(remainingLines([rounded], first.lines), { ...input, lines: [{ lineId: '1', grossCents: 1 }] })).toThrow('amount_too_small');
    });
    it('completes partial credits exactly for many rates and amounts', () => {
        for (const rate of [0, 5, 8, 19])
            for (let base = 100; base < 1500; base += 17) {
                const tax = Math.round(base * rate / 100);
                const original = { ...line, lineTotalCents: base, taxCents: tax, grossCents: base + tax };
                const a = buildProposal(remainingLines([original], []), { ...input, lines: [{ lineId: '1', grossCents: Math.floor(original.grossCents / 3) }] });
                const b = buildProposal(remainingLines([original], a.lines), { ...input, mode: 'total' });
                expect(a.subtotalCents + b.subtotalCents).toBe(base);
                expect(a.taxCents + b.taxCents).toBe(tax);
            }
    });
});
