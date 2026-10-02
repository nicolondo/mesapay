import { secureApi } from '@/lib/secureApi';
import { z } from 'zod';
import { creditNoteApi } from '@/lib/dian/creditNotes/api';
import { CreditNoteError } from '@/lib/dian/creditNotes/domain';
import { configureCreditNoteSeries, getCreditNoteSeries } from '@/lib/dian/creditNotes/service';
export const dynamic = 'force-dynamic';
const inputSchema = z.object({ prefix: z.string().trim().regex(/^[A-Z0-9]{1,10}$/), nextNumber: z.number().int().min(1).max(2147483646).optional() }).strict();
export const GET = secureApi(async () => creditNoteApi(async (ctx) => ({ series: await getCreditNoteSeries(ctx.restaurantId) })));
export const POST = secureApi(async (req: Request) => creditNoteApi(async (ctx) => {
    const input = inputSchema.safeParse(await req.json().catch(() => null));
    if (!input.success)
        throw new CreditNoteError('invalid', 400);
    return { series: await configureCreditNoteSeries(ctx.restaurantId, ctx.userId, input.data) };
}));
