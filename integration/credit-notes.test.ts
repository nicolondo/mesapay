import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { db } from '../src/lib/db';
const scope=vi.hoisted(()=>({restaurantId:''}));
vi.mock('../src/lib/secureApi',()=>({secureApi:(handler:unknown)=>handler}));
vi.mock('../src/lib/erp/access',()=>({getErpContext:async()=>({restaurantId:scope.restaurantId,userId:null}),isDenied:()=>false}));
import { POST as previewRoute } from '../src/app/api/operator/credit-notes/preview/route';
import { POST as createRoute } from '../src/app/api/operator/credit-notes/route';
import { originalInvoiceInput } from '../src/lib/dian/__fixtures__/creditNote';
import { buildDianInvoiceXml } from '../src/lib/dian/ubl';
import { createCreditNote, getCreditNoteSource, abandonCreditNote, getCreditNote, listCreditNoteInvoices, previewCreditNote, configureCreditNoteSeries, getCreditNoteSeries } from '../src/lib/dian/creditNotes/service';
import type { CreditNoteInput } from '../src/lib/dian/creditNotes/types';
const url = new URL(process.env.DATABASE_URL ?? 'postgresql://localhost/invalid');
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(url.pathname))
    throw new Error('Isolated local database required');
const tenants: string[] = [];
const invoiceIds: string[] = [];
const prefix = `T${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`;
async function fixture(restaurantId: string, tableId: string, number: number) {
    const order = await db.order.create({ data: { restaurantId, tableId, status: 'paid', paidAt: new Date(), shortCode: randomUUID() } });
    const built = buildDianInvoiceXml({ ...originalInvoiceInput, invoiceNumber: `FE${number}` });
    const zip = await new JSZip().file('invoice.xml', built.xml).generateAsync({ type: 'nodebuffer' });
    const invoice = await db.simpleInvoice.create({ data: { restaurantId, orderId: order.id, invoiceNumber: number, totalCents: 999999, email: 'fixture@example.test', snapshot: { invoicePrefix: 'FE' }, dianDocument: { create: { restaurantId, orderId: order.id, kind: 'invoice', state: 'accepted', cufe: built.cufe, xmlZip: new Uint8Array(zip) } } } });
    invoiceIds.push(invoice.id);
    return invoice.id;
}
beforeAll(async () => {
    for (let i = 0; i < 2; i++) {
        const tenant = await db.restaurant.create({ data: { name: 'Credit note fixture', taxId: originalInvoiceInput.supplier.companyId, slug: `credit-${randomUUID()}`, dianConfig: { create: { creditNotePrefix: prefix, environment: 'habilitacion' } } } });
        tenants.push(tenant.id);
        const table = await db.table.create({ data: { restaurantId: tenant.id, number: 1, label: 'Test', qrToken: randomUUID() } });
        for (let n = 1; n <= 4; n++)
            await fixture(tenant.id, table.id, n);
    }
});
afterAll(async () => {
    await db.dianDocument.deleteMany({ where: { restaurantId: { in: tenants } } });
    await db.creditNote.deleteMany({ where: { restaurantId: { in: tenants } } });
    await db.creditNoteSeries.deleteMany({ where: { prefix: {in:[prefix,prefix+'2']} } });
    await db.restaurant.deleteMany({ where: { id: { in: tenants } } });
    await db.$disconnect();
});
async function input(id: string, mode: 'total' | 'partial' = 'partial'): Promise<CreditNoteInput> {
    const source = await getCreditNoteSource(tenants[0], id);
    return { originalInvoiceId: id, requestId: randomUUID(), sourceVersion: source.sourceVersion, mode, reasonCode: '3', reasonText: 'Adjustment validation', lines: [{ lineId: '1', grossCents: 10800 }] };
}
describe('credit-note fiscal reservations in PostgreSQL', () => {
    it('uses signed fiscal totals, includes anonymous invoices, and isolates tenants', async () => {
        const source = await getCreditNoteSource(tenants[0], invoiceIds[0]);
        expect(source.remainingTotalCents).toBe(26600);
        expect((await listCreditNoteInvoices(tenants[0], '')).find(i => i.id === invoiceIds[0])).toMatchObject({ totalCents: 26600, customerName: 'Consumidor final' });
        await expect(getCreditNoteSource(tenants[1], invoiceIds[0])).rejects.toMatchObject({ status: 404 });
    });
    it('rejects mismatched current issuer or environment before reserving a note', async () => {
        await db.restaurant.update({where:{id:tenants[0]},data:{taxId:'900000000'}});
        await expect(getCreditNoteSource(tenants[0],invoiceIds[0])).rejects.toThrow('issuer_mismatch');
        await db.restaurant.update({where:{id:tenants[0]},data:{taxId:originalInvoiceInput.supplier.companyId}});
        await db.dianConfig.update({where:{restaurantId:tenants[0]},data:{environment:'produccion'}});
        await expect(getCreditNoteSource(tenants[0],invoiceIds[0])).rejects.toThrow('environment_mismatch');
        await db.dianConfig.update({where:{restaurantId:tenants[0]},data:{environment:'habilitacion'}});
    });
    it('previews the actual UI draft without requestId and never reserves or advances a number',async()=>{
        scope.restaurantId=tenants[0];
        const full=await input(invoiceIds[0]);
        const {requestId,...draft}=full; expect(requestId).toBeTruthy();
        const before=await getCreditNoteSeries(tenants[0]);
        const request=()=>new Request('http://localhost/api/operator/credit-notes/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(draft)});
        const response=await previewRoute(request());
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({proposal:{totalCents:10800,taxCents:800}});
        expect(await db.creditNote.count({where:{restaurantId:tenants[0]}})).toBe(0);
        expect(await getCreditNoteSeries(tenants[0])).toEqual(before);
        expect((await createRoute(request())).status).toBe(400);
    });
    it('repeated and concurrent exact requests create one durable note and one number', async () => {
        const intent = await input(invoiceIds[0]);
        const [a, b] = await Promise.all([createCreditNote(tenants[0], null, intent), createCreditNote(tenants[0], null, intent)]);
        expect(a.id).toBe(b.id);
        expect(a.totalCents).toBe(10800);
        expect(a.taxCents).toBe(800);
        expect(a.snapshot.recipientEmail).toBe('fixture@example.test');
        expect(a.document?.state).toBe('to_send');
        expect(await db.creditNote.count({ where: { restaurantId: tenants[0], requestId: intent.requestId } })).toBe(1);
        await expect(createCreditNote(tenants[0], null, { ...intent, reasonText: 'Different payload' })).rejects.toThrow('idempotency_conflict');
        await expect(getCreditNote(tenants[1], a.id)).rejects.toMatchObject({ status: 404 });
    });
    it('rejects stale reviewed totals and concurrent differing requests', async () => {
        const intent = await input(invoiceIds[1], 'total');
        const results = await Promise.allSettled([createCreditNote(tenants[0], null, intent), createCreditNote(tenants[0], null, { ...intent, requestId: randomUUID() })]);
        expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
        await expect(previewCreditNote(tenants[0], intent)).rejects.toThrow('source_changed');
        expect((await getCreditNoteSource(tenants[0], invoiceIds[1])).remainingTotalCents).toBe(0);
    });
    it('keeps rejected credits reserved until explicit irreversible abandonment', async () => {
        const note = await createCreditNote(tenants[0], null, await input(invoiceIds[2]));
        await db.dianDocument.update({ where: { id: note.document!.id }, data: { state: 'rejected', attempts: 1, xmlZip: Buffer.from('fake fixture') } });
        expect((await getCreditNoteSource(tenants[0], invoiceIds[2])).remainingTotalCents).toBe(15800);
        const abandoned = await abandonCreditNote(tenants[0], note.id, null);
        expect(abandoned.document?.state).toBe('abandoned');
        expect(abandoned.canRetry).toBe(false);
        expect((await getCreditNoteSource(tenants[0], invoiceIds[2])).remainingTotalCents).toBe(26600);
        expect((await abandonCreditNote(tenants[0], note.id, null)).id).toBe(note.id);
    });
    it('blocks abandoning uncertain signed attempts and preserves paid order state', async () => {
        const note = await createCreditNote(tenants[0], null, await input(invoiceIds[3]));
        await db.dianDocument.update({ where: { id: note.document!.id }, data: { state: 'error', attempts: 1, xmlZip: Buffer.from('fake fixture') } });
        await expect(abandonCreditNote(tenants[0], note.id, null)).rejects.toThrow('cannot_abandon');
        const invoice = await db.simpleInvoice.findUniqueOrThrow({ where: { id: invoiceIds[3] }, include: { order: true } });
        expect(invoice.order.status).toBe('paid');
    });
    it('configures a first number and never rewinds a global fiscal series', async () => {
        const current = await getCreditNoteSeries(tenants[0]);
        const advanced = await configureCreditNoteSeries(tenants[0], null, { prefix, nextNumber: current.nextNumber + 100 });
        expect(advanced.nextNumber).toBe(current.nextNumber + 100);
        await expect(configureCreditNoteSeries(tenants[1], null, { prefix, nextNumber: 1 })).rejects.toThrow('series_cannot_rewind');
        expect((await getCreditNoteSeries(tenants[1])).nextNumber).toBe(advanced.nextNumber);
    });
    it('shares sequence across restaurants with same fiscal issuer, environment and prefix', async () => {
        const first = await input(invoiceIds[0], 'total');
        const secondSource = await getCreditNoteSource(tenants[1], invoiceIds[4]);
        const second = { ...first, originalInvoiceId: invoiceIds[4], requestId: randomUUID(), sourceVersion: secondSource.sourceVersion };
        const [a, b] = await Promise.all([createCreditNote(tenants[0], null, first), createCreditNote(tenants[1], null, second)]);
        expect(a.number).not.toBe(b.number);
        expect(a.environment).toBe(b.environment);
    });
    it('rejects concatenated document-number collisions across distinct prefixes',async()=>{
        await configureCreditNoteSeries(tenants[0],null,{prefix,nextNumber:211});
        const first=await createCreditNote(tenants[0],null,await input(invoiceIds[2],'total'));
        expect(first.documentNumber).toBe(`${prefix}211`);
        await configureCreditNoteSeries(tenants[1],null,{prefix:prefix+'2',nextNumber:11});
        const source=await getCreditNoteSource(tenants[1],invoiceIds[5]);
        await expect(createCreditNote(tenants[1],null,{originalInvoiceId:invoiceIds[5],requestId:randomUUID(),sourceVersion:source.sourceVersion,mode:'total',reasonCode:'3',reasonText:'Collision fixture'})).rejects.toThrow('numbering_conflict');
        expect((await getCreditNoteSeries(tenants[1])).nextNumber).toBe(11);
        expect(await db.creditNote.count({where:{fiscalKey:`${source.original.supplier.companyId}:2:${prefix}211`}})).toBe(1);
    });
    it('blocks prefixes overlapping invoice numbering by a numeric suffix',async()=>{
        await db.restaurant.update({where:{id:tenants[0]},data:{invoicePrefix:'FA1'}});
        await expect(configureCreditNoteSeries(tenants[0],null,{prefix:'FA'})).rejects.toThrow('invalid_credit_prefix');
        await expect(configureCreditNoteSeries(tenants[0],null,{prefix:'FA12'})).rejects.toThrow('invalid_credit_prefix');
        await db.restaurant.update({where:{id:tenants[0]},data:{invoicePrefix:prefix+'1'}});
        await expect(getCreditNoteSource(tenants[0],invoiceIds[0])).rejects.toThrow('invalid_credit_prefix');
    });

});
