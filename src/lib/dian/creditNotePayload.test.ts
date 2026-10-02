import { describe, expect, it } from 'vitest';
import { creditNoteSubmissionNames, creditNoteFileYear } from './creditNotePayload';
describe('DIAN 1.9 submission file convention', () => {
    it('pads the issuer NIT and renders an eight-digit hexadecimal sequence', () => {
        expect(creditNoteSubmissionNames('800197268', 2019, 1)).toEqual({ xmlFileName: 'nc08001972680001900000001.xml', zipFileName: 'z08001972680001900000001.zip' });
        expect(creditNoteSubmissionNames('800197268', 2026, 11).xmlFileName).toBe('nc0800197268000260000000B.xml');
    });
    it('resets on January1 in Colombia, not midnight UTC', () => {
        expect(creditNoteFileYear(new Date('2027-01-01T04:59:59Z'))).toBe(2026);
        expect(creditNoteFileYear(new Date('2027-01-01T05:00:00Z'))).toBe(2027);
    });
    it.each([0, -1, 2147483648, 1.5])('rejects unsafe sequence %s', n => {
        expect(() => creditNoteSubmissionNames('800197268', 2026, n)).toThrow('file_numbering_exhausted');
    });
    it('does not truncate a malformed issuer identifier', () => {
        expect(() => creditNoteSubmissionNames('12345678901', 2026, 1)).toThrow('issuer_mismatch');
    });
});
