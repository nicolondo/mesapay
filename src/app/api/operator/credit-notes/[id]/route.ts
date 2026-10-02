import { secureApi } from '@/lib/secureApi';
export const dynamic = 'force-dynamic';
import { getCreditNote } from '@/lib/dian/creditNotes/service';
import { creditNoteApi } from '@/lib/dian/creditNotes/api';
export const GET = secureApi(async (_req: Request, { params }: {
    params: Promise<{
        id: string;
    }>;
}) => creditNoteApi(async (ctx) => ({ creditNote: await getCreditNote(ctx.restaurantId, (await params).id) })));
