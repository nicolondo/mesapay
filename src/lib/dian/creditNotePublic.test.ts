import { beforeEach, expect, it, vi } from 'vitest';
const find = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db', () => ({ db: { creditNote: { findFirst: find } } }));
import { loadPublicCreditNote } from './creditNotePresentation';
import { presentationFixture } from './__fixtures__/creditNotePresentation';
beforeEach(() => vi.clearAllMocks());
it('rejects invalid public tokens before querying', async () => {
  await expect(loadPublicCreditNote('NC1')).rejects.toThrow('not_found'); expect(find).not.toHaveBeenCalled();
});
it('queries the token and accepted fiscal state, never a sequential document number', async () => {
  find.mockResolvedValue(presentationFixture);
  await loadPublicCreditNote('a'.repeat(32));
  expect(find.mock.calls[0][0].where).toEqual({ publicToken: 'a'.repeat(32), abandonedAt: null, dianDocument: { is: { state: 'accepted', kind: 'credit_note' } } });
});
it('does not expose an unaccepted document even if a caller returns it', async () => {
  find.mockResolvedValue({ ...presentationFixture, dianDocument: { ...presentationFixture.dianDocument, state: 'pending' } });
  await expect(loadPublicCreditNote('a'.repeat(32))).rejects.toThrow('not_accepted');
});
