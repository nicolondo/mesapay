import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ context: vi.fn() }));
vi.mock('@/lib/erp/access', () => ({ getErpContext: mock.context, isDenied: (ctx: object) => 'error' in ctx }));
import { creditNoteApi, readCreditInput } from './api';
import { CreditNoteError } from './domain';
beforeEach(() => { mock.context.mockResolvedValue({ restaurantId: 'tenant', userId: 'operator' }); });
describe('credit API authorization and input boundaries', () => {
    it.each([{ error: 'unauthorized', status: 401 }, { error: 'module_disabled', status: 403 }])('does not execute database actions when %s', async (denial) => {
        mock.context.mockResolvedValue(denial);
        const action = vi.fn();
        const response = await creditNoteApi(action);
        expect(response.status).toBe(denial.status);
        expect(action).not.toHaveBeenCalled();
        expect(mock.context).toHaveBeenCalledWith(['einvoicing']);
    });
    it('returns actionable conflict codes instead of an ambiguous server error', async () => {
        const response = await creditNoteApi(async () => { throw new CreditNoteError('source_changed'); });
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ error: 'source_changed' });
    });
    it.each([
        { originalInvoiceId: 'i' },
        { originalInvoiceId: 'i', requestId: 'stable-request', sourceVersion: 'a'.repeat(64), mode: 'partial', reasonCode: '3', reasonText: 'Adjustment', restaurantId: 'other' },
        { originalInvoiceId: 'i', requestId: 'stable-request', sourceVersion: 'a'.repeat(64), mode: 'partial', reasonCode: '3', reasonText: 'Adjustment', lines: [{ lineId: '1', grossCents: 0.5 }] },
    ])('rejects malformed or caller-supplied tenant data', async (body) => {
        await expect(readCreditInput(new Request('http://localhost', { method: 'POST', body: JSON.stringify(body) }))).rejects.toMatchObject({ code: 'invalid', status: 400 });
    });
});
