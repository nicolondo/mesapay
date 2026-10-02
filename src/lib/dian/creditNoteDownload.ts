import { NextResponse } from 'next/server';
import { getErpContext, isDenied } from '@/lib/erp/access';
import {
  loadAcceptedCreditNote, renderCreditNotePdf, creditNoteAttachedXml,
  creditNoteDeliveryZip, creditNoteQrPng, creditNoteFileName,
  CreditNoteDeliveryError, type AcceptedCreditNote,
} from './creditNotePresentation';

export async function creditNoteFileResponse(note: AcceptedCreditNote, format: string, inline = false): Promise<Response> {
  const headers: Record<string, string> = {
    'Cache-Control': 'private, no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer',
  };
  if (format === 'qr') {
    headers['Content-Type'] = 'image/png';
    return new NextResponse(new Uint8Array(await creditNoteQrPng(note)), { headers });
  }
  if (!['pdf', 'xml', 'zip'].includes(format)) return NextResponse.json({ error: 'invalid_format' }, { status: 400 });
  const bytes = format === 'pdf' ? await renderCreditNotePdf(note)
    : format === 'xml' ? Buffer.from(await creditNoteAttachedXml(note)) : await creditNoteDeliveryZip(note);
  headers['Content-Type'] = format === 'pdf' ? 'application/pdf' : format === 'xml' ? 'application/xml; charset=utf-8' : 'application/zip';
  headers['Content-Disposition'] = `${inline ? 'inline' : 'attachment'}; filename="${creditNoteFileName(note, format)}"`;
  return new NextResponse(new Uint8Array(bytes), { headers });
}
export async function staffCreditNoteDownload(
  req: Request, id: string, view: 'download' | 'print' | 'qr',
): Promise<Response> {
  const ctx = await getErpContext(['einvoicing']);
  if (isDenied(ctx)) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  try {
    const note = await loadAcceptedCreditNote(id, ctx.restaurantId);
    const format = view === 'download' ? new URL(req.url).searchParams.get('format') ?? 'pdf' : view === 'print' ? 'pdf' : 'qr';
    return await creditNoteFileResponse(note, format, view === 'print');
  } catch (error) {
    if (error instanceof CreditNoteDeliveryError) return NextResponse.json({ error: error.code }, { status: error.code === 'not_found' ? 404 : 409 });
    throw error;
  }
}
