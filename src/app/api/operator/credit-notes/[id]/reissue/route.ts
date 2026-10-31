import { secureApi } from '@/lib/secureApi';
export const dynamic = 'force-dynamic';
import { reissueCreditNote } from '@/lib/dian/creditNotes/service';
import { creditNoteApi } from '@/lib/dian/creditNotes/api';
/** «Descartar y emitir de nuevo»: descarta la nota y devuelve su reemplazo, todavía sin enviar. */
export const POST = secureApi(async (_req: Request, { params }: {
    params: Promise<{
        id: string;
    }>;
}) => creditNoteApi(async (ctx) => ({ creditNote: await reissueCreditNote(ctx.restaurantId, (await params).id, ctx.userId) }), 201));
