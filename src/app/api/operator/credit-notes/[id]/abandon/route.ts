import { secureApi } from '@/lib/secureApi';
export const dynamic = 'force-dynamic';
import { abandonCreditNote } from '@/lib/dian/creditNotes/service';
import { creditNoteApi } from '@/lib/dian/creditNotes/api';
export const POST = secureApi(async (_req: Request, { params }: {
    params: Promise<{
        id: string;
    }>;
}) => creditNoteApi(async (ctx) => ({ creditNote: await abandonCreditNote(ctx.restaurantId, (await params).id, ctx.userId) })));
