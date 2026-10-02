import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ ctx: vi.fn(), load: vi.fn(), pdf: vi.fn() }));
vi.mock('@/lib/erp/access', () => ({ getErpContext: m.ctx, isDenied: (v: { error?: string }) => !!v.error }));
vi.mock('./creditNotePresentation', () => ({
  loadAcceptedCreditNote: m.load, renderCreditNotePdf: m.pdf, creditNoteFileName: () => 'NC1.pdf',
  CreditNoteDeliveryError: class extends Error {},
}));
import { staffCreditNoteDownload } from './creditNoteDownload';
beforeEach(() => { vi.clearAllMocks(); m.ctx.mockResolvedValue({ restaurantId: 'tenant-a' }); m.load.mockResolvedValue({}); m.pdf.mockResolvedValue(Buffer.from('%PDF')); });
it('requires staff and electronic invoicing access before reading a document', async () => {
  m.ctx.mockResolvedValue({ error: 'unauthorized', status: 401 });
  expect((await staffCreditNoteDownload(new Request('https://mesapay.co/download'), 'id', 'download')).status).toBe(401);
  expect(m.ctx).toHaveBeenCalledWith(['einvoicing']); expect(m.load).not.toHaveBeenCalled();
});
it('passes the active tenant into the lookup and returns a private download', async () => {
  const response = await staffCreditNoteDownload(new Request('https://mesapay.co/download'), 'id', 'download');
  expect(m.load).toHaveBeenCalledWith('id', 'tenant-a');
  expect(response.headers.get('content-type')).toBe('application/pdf');
  expect(response.headers.get('cache-control')).toContain('no-store');
  expect(response.headers.get('content-disposition')).toContain('attachment');
});
it('printing returns only the credit-note PDF inline without sending any printer job', async () => {
  const response = await staffCreditNoteDownload(new Request('https://mesapay.co/print'), 'id', 'print');
  expect(response.headers.get('content-disposition')).toContain('inline');
});
