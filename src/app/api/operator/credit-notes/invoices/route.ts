import { secureApi } from '@/lib/secureApi';
export const dynamic = 'force-dynamic';
import { listCreditNoteInvoices } from '@/lib/dian/creditNotes/service';
import { creditNoteApi } from '@/lib/dian/creditNotes/api';
export const GET = secureApi(async (req: Request) => creditNoteApi(async (ctx) => ({ invoices: await listCreditNoteInvoices(ctx.restaurantId, new URL(req.url).searchParams.get('search') ?? '') })));
