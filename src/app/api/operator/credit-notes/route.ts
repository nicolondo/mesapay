import { secureApi } from '@/lib/secureApi';
export const dynamic = 'force-dynamic';
import { listCreditNotes, createCreditNote } from '@/lib/dian/creditNotes/service';
import { creditNoteApi, readCreditInput } from '@/lib/dian/creditNotes/api';
export const GET = secureApi(async () => creditNoteApi(async (ctx) => ({ notes: await listCreditNotes(ctx.restaurantId) })));
export const POST = secureApi(async (req: Request) => creditNoteApi(async (ctx) => ({ creditNote: await createCreditNote(ctx.restaurantId, ctx.userId, await readCreditInput(req)) }), 201));
