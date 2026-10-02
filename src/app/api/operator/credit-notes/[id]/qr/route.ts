import { secureApi } from '@/lib/secureApi';
import { staffCreditNoteDownload } from '@/lib/dian/creditNoteDownload';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const GET = secureApi(async (req: Request, { params }: { params: Promise<{ id: string }> }) =>
  staffCreditNoteDownload(req, (await params).id, 'qr'));
