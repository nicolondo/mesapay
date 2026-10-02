import { NextResponse } from 'next/server';
import { loadPublicCreditNote } from '@/lib/dian/creditNotePresentation';
import { creditNoteFileResponse } from '@/lib/dian/creditNoteDownload';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const query = new URL(req.url).searchParams;
  const format = query.get('format') ?? 'pdf';
  if (!['pdf', 'xml'].includes(format)) return NextResponse.json({ error: 'invalid_format' }, { status: 400 });
  try {
    const note = await loadPublicCreditNote((await params).token);
    return await creditNoteFileResponse(note, format, query.get('inline') === '1' && format === 'pdf');
  } catch {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' } });
  }
}
