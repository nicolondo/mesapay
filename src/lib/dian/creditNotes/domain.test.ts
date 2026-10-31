import { describe, expect, it } from 'vitest';
import { buildProposal, chooseCreditNotePrefix, reissueCreditNoteInput, reissueRequestId, remainingLines, seriesInConflict, sourceVersion, CreditNoteError, type CreditNoteSeriesUsage } from './domain';
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

describe('descartar notas fallidas (NC1 / NC3 / NCM1)', () => {
    it('NC3: el rechazo regla 90 de la DIAN es definitivo y se puede descartar aunque tenga XML firmado', async () => {
        const { canAbandon } = await import('./domain');
        const { nc3Conflict } = await import('../__fixtures__/creditNoteFailures');
        expect(canAbandon(nc3Conflict, null)).toBe(true);
        expect(canAbandon(nc3Conflict, new Date())).toBe(false);
        expect(canAbandon({ ...nc3Conflict, leaseExpiresAt: new Date(Date.now() + 60_000) }, null)).toBe(false);
    });
    it('NC1: pendiente con 66 todavía no se descarta; «No recibida por la DIAN» sí', async () => {
        const { canAbandon } = await import('./domain');
        const { nc1Pending, nc1NotReceived } = await import('../__fixtures__/creditNoteFailures');
        expect(canAbandon(nc1Pending, null)).toBe(false);
        expect(canAbandon(nc1NotReceived, null)).toBe(true);
    });
    it('NCM1: una nota aceptada nunca se descarta', async () => {
        const { canAbandon } = await import('./domain');
        const { ncm1Accepted } = await import('../__fixtures__/creditNoteFailures');
        expect(canAbandon(ncm1Accepted, null)).toBe(false);
    });
    it('un error de canal con XML firmado sigue sin poder descartarse', async () => {
        const { canAbandon } = await import('./domain');
        const { nc3Conflict, soapFaultResponse, gatewayErrorResponse } = await import('../__fixtures__/creditNoteFailures');
        for (const lastError of ['transport_error', 'la DIAN no respondió', 'The operation was aborted due to timeout', 'a:InvalidSecurity: An error occurred'])
            expect(canAbandon({ ...nc3Conflict, lastError }, null)).toBe(false);
        for (const responseXml of [soapFaultResponse, gatewayErrorResponse, null])
            expect(canAbandon({ ...nc3Conflict, lastError: 'response_identifier_mismatch', responseXml }, null)).toBe(false);
    });
});

describe('serie activa de notas crédito', () => {
    const usage = (prefix: string, over: Partial<CreditNoteSeriesUsage> = {}): CreditNoteSeriesUsage => ({ prefix, nextNumber: 1, maxConflictNumber: null, maxAcceptedNumber: null, lastAcceptedAt: null, ...over });
    const any = () => true;
    // Estado real: NC con conflictos en NC2 y NC3 (próximo 4), NCM con NCM1 aceptada (próximo 2).
    const nc = usage('NC', { nextNumber: 4, maxConflictNumber: 3 });
    const ncm = usage('NCM', { nextNumber: 2, maxAcceptedNumber: 1, lastAcceptedAt: new Date('2026-10-27T15:00:00Z') });
    it('una serie con conflicto regla 90 y ninguna aceptación posterior está en conflicto', () => {
        expect(seriesInConflict(nc)).toBe(true);
        expect(seriesInConflict(ncm)).toBe(false);
        expect(seriesInConflict(usage('NC', { maxConflictNumber: 3, maxAcceptedNumber: 7 }))).toBe(false);
        expect(seriesInConflict(usage('NC', { maxConflictNumber: 3, maxAcceptedNumber: 2 }))).toBe(true);
    });
    it('si NC sigue configurada, la nota nueva sale en NCM', () => {
        expect(chooseCreditNotePrefix('NC', [nc, ncm], any)).toEqual({ prefix: 'NCM', conflictPrefix: 'NC', blocked: false });
    });
    it('con NCM configurada, se usa NCM sin aviso', () => {
        expect(chooseCreditNotePrefix('NCM', [nc, ncm], any)).toEqual({ prefix: 'NCM', conflictPrefix: null, blocked: false });
    });
    it('sin conflicto se respeta la serie configurada', () => {
        expect(chooseCreditNotePrefix('NC', [usage('NC', { maxAcceptedNumber: 5 }), ncm], any).prefix).toBe('NC');
        expect(chooseCreditNotePrefix('NEW', [nc, ncm], any)).toEqual({ prefix: 'NEW', conflictPrefix: null, blocked: false });
    });
    it('nunca elige una serie sin aceptaciones, en conflicto o inválida; si no hay ninguna, bloquea', () => {
        expect(chooseCreditNotePrefix('NC', [nc, usage('NCX')], any)).toEqual({ prefix: 'NC', conflictPrefix: 'NC', blocked: true });
        expect(chooseCreditNotePrefix('NC', [nc, usage('NCZ', { maxConflictNumber: 1 })], any).blocked).toBe(true);
        expect(chooseCreditNotePrefix('NC', [nc, ncm], prefix => prefix !== 'NCM').blocked).toBe(true);
    });
    it('entre varias series limpias elige la de aceptación más reciente', () => {
        const older = usage('NCA', { maxAcceptedNumber: 9, lastAcceptedAt: new Date('2026-01-01T00:00:00Z') });
        expect(chooseCreditNotePrefix('NC', [nc, older, ncm], any).prefix).toBe('NCM');
    });
});

describe('reemisión de una nota descartada', () => {
    const lines = [{ ...line, originalLineId: '1', quantity: 1, grossCents: 40, taxCents: 6, lineTotalCents: 34, unitPriceCents: 34 }];
    it('repite factura, motivo, explicación e importes por línea con una clave idempotente', () => {
        expect(reissueCreditNoteInput({ id: 'nc3', originalInvoiceId: 'inv', reasonCode: '3', reasonText: 'Descuento acordado', snapshot: { lines } }, 'a'.repeat(64))).toEqual({
            originalInvoiceId: 'inv', requestId: 'reissue:nc3', sourceVersion: 'a'.repeat(64), mode: 'partial', reasonCode: '3', reasonText: 'Descuento acordado', lines: [{ lineId: '1', grossCents: 40 }],
        });
        expect(reissueRequestId('nc3')).toBe('reissue:nc3');
    });
    it('la anulación (motivo 2) se reemite como ajuste total', () => {
        expect(reissueCreditNoteInput({ id: 'nc2', originalInvoiceId: 'inv', reasonCode: '2', reasonText: 'Anulación', snapshot: { lines } }, 'a'.repeat(64))).toMatchObject({ mode: 'total', reasonCode: '2' });
    });
});
