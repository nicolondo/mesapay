import { secureApi } from '@/lib/secureApi';
export const dynamic = 'force-dynamic';
import { previewCreditNote } from '@/lib/dian/creditNotes/service';
import { creditNoteApi, readCreditPreviewInput } from '@/lib/dian/creditNotes/api';
export const POST = secureApi(async (req: Request) => creditNoteApi(async (ctx) => ({ proposal: await previewCreditNote(ctx.restaurantId, await readCreditPreviewInput(req)) })));
