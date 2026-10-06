import 'server-only';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { db } from '@/lib/db';
import { unzipFirstXml } from '../soap';
import { parseAcceptedInvoiceXml } from '../creditNoteSource';
import { documentErrors } from '../config';
import { formatInvoiceNumber, type InvoiceSnapshot } from '@/lib/invoice';
import { buildProposal, canAbandon, CreditNoteError, remainingLines, requestHash, sourceVersion } from './domain';
import type { CreditNoteDto, CreditNoteInput, CreditNotePreviewInput, CreditNoteSnapshot, CreditNoteSource, OriginalInvoiceSnapshot } from './types';
import { isModuleEnabled } from '@/lib/modules';
import { getAccountingConfig } from '@/lib/erp/cierre';
import { creditNoteInstant, ensureCreditNoteStamps } from '@/lib/erp/creditNoteAccounting';
import { creditNoteAccountingStatus, creditNoteFiscalDate, monthOfIsoDate } from '@/lib/erp/creditNoteLedger';
type Client = Prisma.TransactionClient;
const noteInclude = { dianDocument: true, series: true } satisfies Prisma.CreditNoteInclude;
type Note = Prisma.CreditNoteGetPayload<{
    include: typeof noteInclude;
}>;
export function creditNoteDto(note: Note): CreditNoteDto {
    const d = note.dianDocument;
    return { accounting: null, id: note.id, publicToken: note.publicToken, originalInvoiceId: note.originalInvoiceId, documentNumber: note.documentNumber, number: note.number, reasonCode: note.reasonCode, reasonText: note.reasonText, subtotalCents: note.subtotalCents, taxCents: note.taxCents, totalCents: note.totalCents, environment: note.series.environment as '1' | '2', createdAt: note.createdAt.toISOString(), abandonedAt: note.abandonedAt?.toISOString() ?? null, snapshot: note.snapshot as unknown as CreditNoteSnapshot, canAbandon: canAbandon(d, note.abandonedAt), canRetry: !note.abandonedAt && !!d && ['to_send', 'error', 'pending'].includes(d.state) && (!d.leaseExpiresAt || d.leaseExpiresAt <= new Date()), document: d ? { id: d.id, state: d.state, cufe: d.cufe, trackId: d.trackId, errors: documentErrors(d.errors), lastError: d.lastError, issuedAt: d.issuedAt?.toISOString() ?? null, emailedAt: d.emailedAt?.toISOString() ?? null, emailError: d.emailError } : null };
}
async function sourceData(client: Client, restaurantId: string, invoiceId: string) {
    const invoice = await client.simpleInvoice.findFirst({ where: { id: invoiceId, restaurantId }, include: { dianDocument: true, order: { select: { locale: true } }, restaurant: { select: { name: true, taxId: true, invoicePrefix: true, legalEntityId: true, dianConfig: true, legalEntity: { select: { taxId: true, invoicePrefix: true, dianConfig: true } } } } } });
    const document = invoice?.dianDocument;
    if (!invoice || !document || document.kind !== 'invoice' || document.state !== 'accepted' || !document.xmlZip || !document.cufe)
        throw new CreditNoteError('accepted_invoice_required', 404);
    const xml = await unzipFirstXml(document.xmlZip);
    if (!xml)
        throw new CreditNoteError('source_unsupported');
    let original: OriginalInvoiceSnapshot;
    try {
        original = { ...parseAcceptedInvoiceXml(xml), documentId: document.id };
    }
    catch {
        throw new CreditNoteError('source_unsupported');
    }
    if (original.cufe !== document.cufe)
        throw new CreditNoteError('source_unsupported');
    const currentIssuer = invoice.restaurant.legalEntityId ? invoice.restaurant.legalEntity : invoice.restaurant;
    const currentNit = (currentIssuer?.taxId ?? '').split('-')[0].replace(/\D/g, '');
    if (currentNit !== original.supplier.companyId) throw new CreditNoteError('issuer_mismatch');
    const config = currentIssuer?.dianConfig;
    if (!config)
        throw new CreditNoteError('dian_not_configured');
    if (original.environment !== (config.environment === 'produccion' ? '1' : '2'))
        throw new CreditNoteError('environment_mismatch');
    const prefix = config.creditNotePrefix;
    if (!/^[A-Z0-9]{1,10}$/.test(prefix) || prefixesOverlap(prefix,currentIssuer?.invoicePrefix??''))
        throw new CreditNoteError('invalid_credit_prefix');
    const notes = await client.creditNote.findMany({ where: { restaurantId, originalInvoiceId: invoiceId }, include: noteInclude, orderBy: { createdAt: 'desc' } });
    const active = notes.filter(n => !n.abandonedAt);
    const lines = remainingLines(original.lines, active.flatMap(n => (n.snapshot as unknown as CreditNoteSnapshot).lines));
    const version = sourceVersion(createHash('sha256').update(xml).update(prefix).digest('hex'), active.map(n => ({ id: n.id, lines: (n.snapshot as unknown as CreditNoteSnapshot).lines })));
    const scope = { issuerNit: original.supplier.companyId, environment: original.environment, prefix };
    const series = await client.creditNoteSeries.findUnique({ where: { issuerNit_environment_prefix: scope } });
    const source: CreditNoteSource = { originalInvoiceId: invoiceId, original, lines, remainingTotalCents: lines.reduce((s, l) => s + l.remainingGrossCents, 0), sourceVersion: version, prefix, nextNumber: series?.nextNumber ?? 1, notes: notes.map(creditNoteDto) };
    return { source, scope, invoice };
}
export async function getCreditNoteSource(restaurantId: string, invoiceId: string) { return (await sourceData(db, restaurantId, invoiceId)).source; }
export async function previewCreditNote(restaurantId: string, input: CreditNotePreviewInput) {
    const { source } = await sourceData(db, restaurantId, input.originalInvoiceId);
    if (source.sourceVersion !== input.sourceVersion)
        throw new CreditNoteError('source_changed');
    return buildProposal(source.lines, input);
}
async function lock(client: Client, key: string) { await client.$executeRaw `SELECT pg_advisory_xact_lock(hashtext(${key}))`; }
export async function createCreditNote(restaurantId: string, userId: string | null, input: CreditNoteInput): Promise<CreditNoteDto> {
    const hash = requestHash(input);
    return db.$transaction(async (tx) => {
        await tx.$executeRaw `SELECT pg_advisory_xact_lock(hashtext(${restaurantId}), 947)`;
        await lock(tx, `credit-request:${restaurantId}:${input.requestId}`);
        const existing = await tx.creditNote.findUnique({ where: { restaurantId_requestId: { restaurantId, requestId: input.requestId } }, include: noteInclude });
        if (existing) {
            if (existing.requestHash !== hash)
                throw new CreditNoteError('idempotency_conflict');
            return creditNoteDto(existing);
        }
        await lock(tx, `credit-invoice:${input.originalInvoiceId}`);
        const { source, scope, invoice } = await sourceData(tx, restaurantId, input.originalInvoiceId);
        if (source.sourceVersion !== input.sourceVersion)
            throw new CreditNoteError('source_changed');
        const proposal = buildProposal(source.lines, input);
        await lock(tx, `credit-series:${scope.issuerNit}:${scope.environment}`);
        const series = await tx.creditNoteSeries.upsert({ where: { issuerNit_environment_prefix: scope }, create: scope, update: {} });
        const allocated = await tx.creditNoteSeries.updateMany({ where: { id: series.id, nextNumber: { lt: 2147483647 } }, data: { nextNumber: { increment: 1 } } });
        if (!allocated.count)
            throw new CreditNoteError('numbering_exhausted');
        const current = await tx.creditNoteSeries.findUniqueOrThrow({ where: { id: series.id } });
        const number = current.nextNumber - 1;
        const documentNumber = `${scope.prefix}${number}`;
        const fiscalKey = `${scope.issuerNit}:${scope.environment}:${documentNumber}`;
        if (await tx.creditNote.findUnique({where:{fiscalKey},select:{id:true}})) throw new CreditNoteError('numbering_conflict');
        const snapshot: CreditNoteSnapshot = { version: 1, originalDocumentId: source.original.documentId, original: source.original, lines: proposal.lines, locale: invoice.order.locale ?? 'es', recipientEmail: source.original.customer.email || invoice.email || null, brandName: invoice.restaurant.name };
        const note = await tx.creditNote.create({ data: { fiscalKey, restaurantId, originalInvoiceId: input.originalInvoiceId, seriesId: series.id, number, documentNumber, requestId: input.requestId, requestHash: hash, reasonCode: input.reasonCode, reasonText: input.reasonText, snapshot: snapshot as unknown as Prisma.InputJsonValue, subtotalCents: proposal.subtotalCents, taxCents: proposal.taxCents, totalCents: proposal.totalCents, createdById: userId, dianDocument: { create: { restaurantId, orderId: invoice.orderId, kind: 'credit_note', state: 'to_send' } } }, include: noteInclude });
        const actor = userId ? await tx.user.findUnique({ where: { id: userId }, select: { email: true, role: true } }) : null;
        await tx.auditEvent.create({ data: { restaurantId, actorUserId: userId, actorEmail: actor?.email ?? 'system', actorRole: actor?.role ?? 'system', kind: 'credit_note.create', targetType: 'CreditNote', targetId: note.id, summary: `Credit note ${note.documentNumber}`, diff: { originalInvoiceId: invoice.id, totalCents: note.totalCents } } });
        return creditNoteDto(note);
    }, { timeout: 15000 }).catch(error=>{
        if(error instanceof Prisma.PrismaClientKnownRequestError && error.code==='P2002' && String(error.meta?.target).includes('fiscalKey')) throw new CreditNoteError('numbering_conflict');
        throw error;
    });
}
/**
 * Contexto contable de la pantalla de notas. Antes fija las notas aceptadas
 * que quedaron sin fijar (la cartera de cliente depende de eso, con o sin
 * módulo de contabilidad). El estado «Contabilizada en …» sólo aplica con
 * el módulo de contabilidad: sin él no hay diario que la asiente.
 */
async function accountingContext(restaurantId: string): Promise<{ closedThrough: string | null } | null> {
    await ensureCreditNoteStamps(restaurantId);
    const restaurant = await db.restaurant.findUnique({ where: { id: restaurantId }, select: { enabledModules: true } });
    if (!restaurant || !isModuleEnabled(restaurant.enabledModules, 'accounting'))
        return null;
    return { closedThrough: (await getAccountingConfig(restaurantId)).closedThrough };
}
/** DTO + «Contabilizada en <mes>» / «Pendiente de contabilizar» de una nota aceptada. */
function accountedDto(note: Note, ctx: { closedThrough: string | null } | null): CreditNoteDto {
    const dto = creditNoteDto(note);
    if (!ctx || note.abandonedAt || note.dianDocument?.state !== 'accepted')
        return dto;
    const fiscalMonth = monthOfIsoDate(creditNoteFiscalDate(creditNoteInstant(note)));
    return { ...dto, accounting: creditNoteAccountingStatus({ postedMonth: note.postedMonth, fiscalMonth, closedThrough: ctx.closedThrough }) };
}
export async function getCreditNote(restaurantId: string, id: string) {
    const ctx = await accountingContext(restaurantId);
    const note = await db.creditNote.findFirst({ where: { id, restaurantId }, include: noteInclude });
    if (!note)
        throw new CreditNoteError('not_found', 404);
    return accountedDto(note, ctx);
}
export async function listCreditNotes(restaurantId: string) {
    const ctx = await accountingContext(restaurantId);
    return (await db.creditNote.findMany({ where: { restaurantId }, include: noteInclude, orderBy: { createdAt: 'desc' }, take: 100 })).map(note => accountedDto(note, ctx));
}
export async function abandonCreditNote(restaurantId: string, id: string, userId: string | null) {
    return db.$transaction(async (tx) => {
        const initial = await tx.creditNote.findFirst({ where: { id, restaurantId }, select: { originalInvoiceId: true } });
        if (!initial)
            throw new CreditNoteError('not_found', 404);
        await lock(tx, `credit-invoice:${initial.originalInvoiceId}`);
        const note = await tx.creditNote.findFirstOrThrow({ where: { id, restaurantId }, include: noteInclude });
        if (note.abandonedAt)
            return creditNoteDto(note);
        if (!canAbandon(note.dianDocument, note.abandonedAt))
            throw new CreditNoteError('cannot_abandon');
        const updated = await tx.dianDocument.updateMany({ where: { id: note.dianDocument!.id, state: note.dianDocument!.state, ...(note.dianDocument!.state === 'rejected' ? {} : { xmlZip: null, attempts: 0 }), OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: new Date() } }] }, data: { state: 'abandoned', nextAttemptAt: null } });
        if (!updated.count)
            throw new CreditNoteError('cannot_abandon');
        const result = await tx.creditNote.update({ where: { id }, data: { abandonedAt: new Date() }, include: noteInclude });
        const actor = userId ? await tx.user.findUnique({ where: { id: userId }, select: { email: true, role: true } }) : null;
        await tx.auditEvent.create({ data: { restaurantId, actorUserId: userId, actorEmail: actor?.email ?? 'system', actorRole: actor?.role ?? 'system', kind: 'credit_note.abandon', targetType: 'CreditNote', targetId: id, summary: `Abandoned ${note.documentNumber}` } });
        return creditNoteDto(result);
    });
}
export async function listCreditNoteInvoices(restaurantId: string, search: string) {
    const q = search.trim().slice(0, 100);
    const numeric = Number(q.replace(/^\D+/, ''));
    const rows = await db.simpleInvoice.findMany({ where: { restaurantId, dianDocument: { kind: 'invoice', state: 'accepted', cufe: { not: null } }, ...(q ? { OR: [{ order: { shortCode: { contains: q, mode: 'insensitive' } } }, { order: { invoiceRequests: { some: { customerName: { contains: q, mode: 'insensitive' } } } } }, ...(Number.isInteger(numeric) && numeric > 0 && numeric <= 2147483647 ? [{ invoiceNumber: numeric }] : [])] } : {}) }, include: { dianDocument: { select: { xmlZip: true } }, order: { select: { paidAt: true, invoiceRequests: { select: { customerName: true }, take: 1, orderBy: { createdAt: 'desc' } } } }, creditNotes: { where: { abandonedAt: null }, select: { totalCents: true, dianDocument: { select: { state: true } } } } }, orderBy: { createdAt: 'desc' }, take: 50 });
    return Promise.all(rows.map(async (row) => {
        let fiscal: ReturnType<typeof parseAcceptedInvoiceXml> | null = null;
        try {
            const xml = row.dianDocument?.xmlZip ? await unzipFirstXml(row.dianDocument.xmlZip) : null;
            if (xml)
                fiscal = parseAcceptedInvoiceXml(xml);
        }
        catch { /* Source endpoint explains unsupported historical profiles. */ }
        return { id: row.id, invoiceNumber: fiscal?.invoiceNumber ?? formatInvoiceNumber(row.snapshot as unknown as InvoiceSnapshot, row.invoiceNumber), customerName: fiscal?.customer.name ?? row.order.invoiceRequests[0]?.customerName ?? null, paidAt: row.order.paidAt?.toISOString() ?? null, totalCents: fiscal?.totals.payableCents ?? row.totalCents, acceptedCreditCents: row.creditNotes.filter(n => n.dianDocument?.state === 'accepted').reduce((s, n) => s + n.totalCents, 0), reservedCreditCents: row.creditNotes.reduce((s, n) => s + n.totalCents, 0) };
    }));
}
async function configuredSeries(client: Client, restaurantId: string) {
    const restaurant = await client.restaurant.findUnique({ where: { id: restaurantId }, select: { taxId: true, invoicePrefix: true, legalEntityId: true, dianConfig: true, legalEntity: { select: { taxId: true, invoicePrefix: true, dianConfig: true } } } });
    if (!restaurant)
        throw new CreditNoteError('not_found', 404);
    const issuer = restaurant.legalEntityId ? restaurant.legalEntity : restaurant;
    const config = issuer?.dianConfig;
    if (!config)
        throw new CreditNoteError('dian_not_configured');
    const issuerNit = (issuer?.taxId ?? '').split('-')[0].replace(/\D/g, '');
    if (!/^[0-9]{5,15}$/.test(issuerNit))
        throw new CreditNoteError('issuer_mismatch');
    return { config, issuerNit, invoicePrefix: issuer?.invoicePrefix ?? '', environment: config.environment === 'produccion' ? '1' : '2' };
}
export async function getCreditNoteSeries(restaurantId: string) {
    const { config, issuerNit, environment } = await configuredSeries(db, restaurantId);
    const series = await db.creditNoteSeries.findUnique({ where: { issuerNit_environment_prefix: { issuerNit, environment, prefix: config.creditNotePrefix } } });
    return { prefix: config.creditNotePrefix, nextNumber: series?.nextNumber ?? 1, issuerNit, environment };
}
export async function configureCreditNoteSeries(restaurantId: string, userId: string | null, input: {
    prefix: string;
    nextNumber?: number;
}) {
    return db.$transaction(async (tx) => {
        await tx.$executeRaw `SELECT pg_advisory_xact_lock(hashtext(${restaurantId}), 947)`;
        const { config, issuerNit, environment, invoicePrefix } = await configuredSeries(tx, restaurantId);
        if (prefixesOverlap(input.prefix, invoicePrefix))
            throw new CreditNoteError('invalid_credit_prefix', 400);
        // Same lock for all establishments of an issuer, independently of their config row.
        await lock(tx, `credit-series:${issuerNit}:${environment}`);
        const key = { issuerNit, environment, prefix: input.prefix };
        const series = await tx.creditNoteSeries.upsert({ where: { issuerNit_environment_prefix: key }, create: key, update: {} });
        // Lock the counter row too: issuance increments it atomically in its own transaction.
        await tx.$queryRaw `SELECT id FROM "CreditNoteSeries" WHERE id=${series.id} FOR UPDATE`;
        const current = await tx.creditNoteSeries.findUniqueOrThrow({ where: { id: series.id } });
        const nextNumber = input.nextNumber ?? current.nextNumber;
        if (nextNumber < current.nextNumber)
            throw new CreditNoteError('series_cannot_rewind');
        await tx.creditNoteSeries.update({ where: { id: series.id }, data: { nextNumber } });
        await tx.dianConfig.update({ where: { id: config.id }, data: { creditNotePrefix: input.prefix } });
        const actor = userId ? await tx.user.findUnique({ where: { id: userId }, select: { email: true, role: true } }) : null;
        await tx.auditEvent.create({ data: { restaurantId, actorUserId: userId, actorEmail: actor?.email ?? 'system', actorRole: actor?.role ?? 'system', kind: 'credit_note.series', targetType: 'CreditNoteSeries', targetId: series.id, summary: `Credit note series ${input.prefix}`, diff: { previousNextNumber: current.nextNumber, nextNumber } } });
        return { prefix: input.prefix, nextNumber, issuerNit, environment };
    });
}

export function prefixesOverlap(a:string,b:string):boolean {
 if(!a||!b) return false;
 return a===b || (a.startsWith(b)&&/^\d+$/.test(a.slice(b.length))) || (b.startsWith(a)&&/^\d+$/.test(b.slice(a.length)));
}
