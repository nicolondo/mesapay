import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getEmailTranslator } from '@/lib/emailIntl';
import { loadPublicCreditNote } from '@/lib/dian/creditNotePresentation';
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { robots: { index: false, follow: false }, referrer: 'no-referrer', manifest: null, appleWebApp: false };

export default async function CreditNotePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const note = await loadPublicCreditNote(token).catch(() => null);
  if (!note) notFound();
  const { t } = await getEmailTranslator(note.snapshot.locale, 'creditNotePresentation');
  const base = `/nota-credito/${encodeURIComponent(token)}/document`;
  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-sm text-neutral-500">{note.snapshot.brandName}</p>
          <h1 className="text-2xl font-semibold">{t('title')} · {note.documentNumber}</h1>
          <p className="mt-1 text-sm text-neutral-500">{t('accepted')}</p>
        </div>
        <nav className="flex flex-wrap gap-3">
          <a className="rounded-full bg-neutral-900 px-5 py-3 text-sm text-white" href={`${base}?format=pdf`}>{t('download')}</a>
          <a className="rounded-full border px-5 py-3 text-sm" href={`${base}?format=pdf&inline=1`} target="_blank" rel="noopener noreferrer">{t('print')}</a>
          <a className="rounded-full border px-5 py-3 text-sm" href={`${base}?format=xml`}>{t('xml')}</a>
        </nav>
      </header>
      <iframe title={t('title')} src={`${base}?format=pdf&inline=1`} className="h-[80vh] min-h-[600px] w-full rounded-xl border bg-white" />
    </main>
  );
}
