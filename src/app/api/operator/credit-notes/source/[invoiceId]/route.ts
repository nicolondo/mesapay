import { secureApi } from '@/lib/secureApi';
export const dynamic = 'force-dynamic';
import { getCreditNoteSource } from '@/lib/dian/creditNotes/service';
import { creditNoteApi } from '@/lib/dian/creditNotes/api';
export const GET = secureApi(async (_req: Request, { params }: {
    params: Promise<{
        invoiceId: string;
    }>;
}) => creditNoteApi(async (ctx) => ({ source: await getCreditNoteSource(ctx.restaurantId, (await params).invoiceId) })));
