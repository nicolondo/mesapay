import { NextResponse } from 'next/server';
import { getErpContext, isDenied, type ErpContext } from '@/lib/erp/access';
import { CreditNoteError, creditNoteInputSchema, creditNotePreviewSchema } from './domain';
import type { CreditNoteInput, CreditNotePreviewInput } from './types';
export async function creditNoteApi(action: (ctx: ErpContext) => Promise<unknown>, status = 200) {
    const ctx = await getErpContext(['einvoicing']);
    if (isDenied(ctx))
        return NextResponse.json({ error: ctx.error }, { status: ctx.status });
    try {
        return NextResponse.json(await action(ctx), { status });
    }
    catch (error) {
        if (error instanceof CreditNoteError)
            return NextResponse.json({ error: error.code }, { status: error.status });
        throw error;
    }
}
export async function readCreditInput(req: Request): Promise<CreditNoteInput> {
    const parsed = creditNoteInputSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success)
        throw new CreditNoteError('invalid', 400);
    return parsed.data;
}

export async function readCreditPreviewInput(req: Request): Promise<CreditNotePreviewInput> {
 const parsed=creditNotePreviewSchema.safeParse(await req.json().catch(()=>null));
 if(!parsed.success) throw new CreditNoteError('invalid',400);
 return parsed.data;
}
