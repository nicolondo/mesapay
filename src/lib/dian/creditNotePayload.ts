import 'server-only';
import JSZip from 'jszip';
import { db } from '@/lib/db';
import { dianIssueDateTime } from './dianDateTime';
import { zipInvoice } from './soap';
import { CreditNoteError } from './creditNotes/domain';
const MAX_SEQUENCE = 2147483647;
export type CreditNoteSubmissionNames = {
    xmlFileName: string;
    zipFileName: string;
};
/** DIAN Annex1.9 §§6.5.7–6.5.8: software propio000, calendar year, hexadecimal sequence. */
export function creditNoteSubmissionNames(issuerNit: string, year: number, sequence: number): CreditNoteSubmissionNames {
    if (!/^\d{1,10}$/.test(issuerNit))
        throw new CreditNoteError('issuer_mismatch');
    if (!Number.isInteger(year) || year < 2000 || year > 9999 || !Number.isInteger(sequence) || sequence < 1 || sequence > MAX_SEQUENCE)
        throw new CreditNoteError('file_numbering_exhausted');
    const stem = issuerNit.padStart(10, '0') + '000' + String(year).slice(-2) + sequence.toString(16).toUpperCase().padStart(8, '0');
    return { xmlFileName: `nc${stem}.xml`, zipFileName: `z${stem}.zip` };
}
export function creditNoteFileYear(issuedAt: Date): number {
    if (!Number.isFinite(issuedAt.getTime()))
        throw new CreditNoteError('incomplete_document');
    return Number(dianIssueDateTime(issuedAt).date.slice(0, 4));
}
class LostCreditNoteLease extends Error {
}
export type PreparedCreditNotePayload = CreditNoteSubmissionNames & {
    zip: Buffer;
};
export type PrepareCreditNotePayloadInput = {
    documentId: string;
    restaurantId: string;
    leaseToken: string;
    issuerNit: string;
    environment: '1' | '2';
    issuedAt: Date;
    cude: string;
    signedXml: string;
};
/** No network. The counter, immutable signed ZIP and issue instant commit together.
 * A stale owner rolls back its counter increment; retrying an existing payload
 * returns its exact bytes and original filename, including across New Year.
 */
export async function prepareCreditNotePayload(input: PrepareCreditNotePayloadInput): Promise<PreparedCreditNotePayload | null> {
    const year = creditNoteFileYear(input.issuedAt);
    creditNoteSubmissionNames(input.issuerNit, year, 1);
    if (!/^[a-f0-9]{96}$/i.test(input.cude) || !input.signedXml || input.signedXml.length > 5000000)
        throw new CreditNoteError('incomplete_document');
    try {
        return await db.$transaction(async (tx) => {
            await tx.$queryRaw `SELECT id FROM "DianDocument" WHERE id=${input.documentId} AND "restaurantId"=${input.restaurantId} AND kind='credit_note' FOR UPDATE`;
            const owned = { id: input.documentId, restaurantId: input.restaurantId, kind: 'credit_note', leaseToken: input.leaseToken, state: { in: ['to_send', 'error', 'sent', 'pending'] }, creditNote: { is: { restaurantId: input.restaurantId, abandonedAt: null, series: { issuerNit: input.issuerNit, environment: input.environment } } } };
            const document = await tx.dianDocument.findFirst({ where: { ...owned, leaseExpiresAt: { gt: new Date() } }, select: { xmlZip: true, submissionFileName: true } });
            if (!document)
                return null;
            if (document.xmlZip) {
                let xmlFileName = document.submissionFileName;
                if (!xmlFileName) {
                    const legacy = await JSZip.loadAsync(document.xmlZip);
                    const entries = Object.values(legacy.files).filter(entry => !entry.dir && entry.name.endsWith('.xml'));
                    if (entries.length !== 1 || !/^[-_a-zA-Z0-9.]+\.xml$/.test(entries[0].name))
                        throw new CreditNoteError('file_name_missing');
                    xmlFileName = entries[0].name;
                }
                const zipFileName = /^nc\d{10}000\d{2}[A-Fa-f0-9]{8}\.xml$/.test(xmlFileName) ? 'z' + xmlFileName.slice(2, -4) + '.zip' : xmlFileName.slice(0, -4) + '.zip';
                return { xmlFileName, zipFileName, zip: Buffer.from(document.xmlZip) };
            }
            if (document.submissionFileName)
                throw new CreditNoteError('incomplete_document');
            const key = { issuerNit: input.issuerNit.padStart(10, '0'), environment: input.environment, year };
            // Prisma's empty-update upsert can emulate read-then-insert; PostgreSQL's
            // ON CONFLICT is required when two establishments open the same year.
            await tx.$executeRaw `INSERT INTO "CreditNoteFileSeries" ("issuerNit", "environment", "year", "lastNumber") VALUES (${key.issuerNit}, ${key.environment}, ${key.year}, 0) ON CONFLICT ("issuerNit", "environment", "year") DO NOTHING`;
            const incremented = await tx.creditNoteFileSeries.updateMany({ where: { ...key, lastNumber: { lt: MAX_SEQUENCE } }, data: { lastNumber: { increment: 1 } } });
            if (!incremented.count)
                throw new CreditNoteError('file_numbering_exhausted');
            const counter = await tx.creditNoteFileSeries.findUniqueOrThrow({ where: { issuerNit_environment_year: key } });
            const names = creditNoteSubmissionNames(input.issuerNit, year, counter.lastNumber);
            const zip = await zipInvoice(names.xmlFileName, input.signedXml);
            const persisted = await tx.dianDocument.updateMany({ where: { ...owned, leaseExpiresAt: { gt: new Date() }, xmlZip: null, submissionFileName: null }, data: { xmlZip: new Uint8Array(zip), cufe: input.cude, issuedAt: input.issuedAt, submissionFileName: names.xmlFileName } });
            if (persisted.count !== 1)
                throw new LostCreditNoteLease();
            return { ...names, zip };
        }, { timeout: 15000 });
    }
    catch (error) {
        if (error instanceof LostCreditNoteLease)
            return null;
        throw error;
    }
}
