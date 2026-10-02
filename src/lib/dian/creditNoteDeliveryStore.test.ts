import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ find: vi.fn(), update: vi.fn(), config: vi.fn(), issuer: vi.fn(), sign: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { dianDocument: { findFirst: m.find, updateMany: m.update } } }));
vi.mock('./config', () => ({ loadDianConfig: m.config, resolveEmisor: m.issuer }));
vi.mock('./soap', () => ({ unzipFirstXml: async () => 'original', extractApplicationResponse: async () => 'response', zipInvoice: vi.fn() }));
vi.mock('./creditNoteContainer', () => ({ buildSignedCreditNoteContainer: m.sign }));
import { assertAcceptedCreditNote, creditNoteAttachedXml } from './creditNotePresentation';
import { presentationFixture } from './__fixtures__/creditNotePresentation';
const note = assertAcceptedCreditNote(presentationFixture);
beforeEach(() => {
  vi.clearAllMocks(); m.find.mockResolvedValue({ deliveryXml: null }); m.update.mockResolvedValue({ count: 1 });
  m.config.mockResolvedValue({ environment: 'habilitacion', cert: {} });
  m.issuer.mockResolvedValue({ taxId: note.snapshot.original.supplier.companyId }); m.sign.mockReturnValue('signed-container');
});
it('serves the original frozen container without any current certificate lookup', async () => {
  expect(await creditNoteAttachedXml({ ...note, dianDocument: { ...note.dianDocument, deliveryXml: 'frozen' } })).toBe('frozen');
  expect(m.config).not.toHaveBeenCalled(); expect(m.sign).not.toHaveBeenCalled();
});
it('persists a signed container only once using tenant-scoped compare-and-set', async () => {
  expect(await creditNoteAttachedXml(note)).toBe('signed-container');
  expect(m.update.mock.calls[0][0]).toMatchObject({ where: { restaurantId: note.restaurantId, state: 'accepted', deliveryXml: null }, data: { deliveryXml: 'signed-container' } });
});
it('returns the winning immutable bytes after a concurrent creation', async () => {
  m.update.mockResolvedValue({ count: 0 }); m.find.mockResolvedValueOnce({ deliveryXml: null }).mockResolvedValueOnce({ deliveryXml: 'winner' });
  expect(await creditNoteAttachedXml(note)).toBe('winner');
});
it('refuses a new signature when current issuer or environment changed', async () => {
  m.issuer.mockResolvedValue({ taxId: '999999999' });
  await expect(creditNoteAttachedXml(note)).rejects.toThrow('incomplete_document');
  expect(m.sign).not.toHaveBeenCalled();
  m.issuer.mockResolvedValue({ taxId: note.snapshot.original.supplier.companyId }); m.config.mockResolvedValue({ environment: 'produccion', cert: {} });
  await expect(creditNoteAttachedXml(note)).rejects.toThrow('incomplete_document');
  expect(m.sign).not.toHaveBeenCalled();
});
