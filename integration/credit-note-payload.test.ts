import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { db } from '../src/lib/db';
import { prepareCreditNotePayload, type PrepareCreditNotePayloadInput } from '../src/lib/dian/creditNotePayload';
const delay = vi.hoisted(() => ({ ms: 0 }));
vi.mock('../src/lib/dian/soap', async (load) => {
    const actual = await load<typeof import('../src/lib/dian/soap')>();
    return { ...actual, zipInvoice: async (name: string, xml: string) => { if (delay.ms)
            await new Promise(resolve => setTimeout(resolve, delay.ms)); return actual.zipInvoice(name, xml); } };
});
const url = new URL(process.env.DATABASE_URL ?? 'postgresql://localhost/invalid');
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(url.pathname))
    throw new Error('Isolated local database required');
const issuerNit = String(7000000000 + Math.floor(Math.random() * 1000000000));
const tenants: string[] = [];
const invoices: string[] = [];
const series: string[] = [];
let sequence = 0;
beforeEach(() => { delay.ms = 0; });
beforeAll(async () => {
    for (let i = 0; i < 2; i++) {
        const r = await db.restaurant.create({ data: { name: 'Payload fixture', slug: `payload-${randomUUID()}` } });
        tenants.push(r.id);
        const table = await db.table.create({ data: { restaurantId: r.id, number: 1, qrToken: randomUUID() } });
        const order = await db.order.create({ data: { restaurantId: r.id, tableId: table.id, status: 'paid', shortCode: randomUUID() } });
        const invoice = await db.simpleInvoice.create({ data: { restaurantId: r.id, orderId: order.id, invoiceNumber: 1, snapshot: {}, totalCents: 100 } });
        invoices.push(invoice.id);
        const s = await db.creditNoteSeries.create({ data: { issuerNit, environment: '2', prefix: i === 0 ? 'NC' : 'CR' } });
        series.push(s.id);
    }
});
afterAll(async () => {
    await db.dianDocument.deleteMany({ where: { restaurantId: { in: tenants } } });
    await db.creditNote.deleteMany({ where: { restaurantId: { in: tenants } } });
    await db.creditNoteSeries.deleteMany({ where: { issuerNit } });
    await db.creditNoteFileSeries.deleteMany({ where: { issuerNit } });
    await db.restaurant.deleteMany({ where: { id: { in: tenants } } });
    await db.$disconnect();
});
async function fixture(index = 0, issuedAt = new Date('2026-10-02T12:00:00Z')): Promise<PrepareCreditNotePayloadInput> {
    const number = ++sequence, documentNumber = `${index ? 'CR' : 'NC'}${number}`, leaseToken = randomUUID();
    const note = await db.creditNote.create({ data: { restaurantId: tenants[index], originalInvoiceId: invoices[index], seriesId: series[index], number, documentNumber, fiscalKey: `${issuerNit}:2:${documentNumber}`, requestId: randomUUID(), requestHash: 'fixture', reasonCode: '3', reasonText: 'Fixture', snapshot: {}, subtotalCents: 100, taxCents: 0, totalCents: 100, dianDocument: { create: { restaurantId: tenants[index], kind: 'credit_note', state: 'to_send', leaseToken, leaseExpiresAt: new Date(Date.now() + 60000) } } }, include: { dianDocument: true } });
    return { documentId: note.dianDocument!.id, restaurantId: tenants[index], leaseToken, issuerNit, environment: '2', issuedAt, cude: 'a'.repeat(96), signedXml: '<signed>original</signed>' };
}
describe('atomic NC annual transport naming and payload', () => {
    it('serializes concurrent requests for one document and preserves exact bytes', async () => {
        const request = await fixture();
        const [a, b] = await Promise.all([prepareCreditNotePayload(request), prepareCreditNotePayload(request)]);
        const retry = await prepareCreditNotePayload({ ...request, issuedAt: new Date('2027-01-01T05:01:00Z'), signedXml: '<signed>different retry</signed>', cude: 'b'.repeat(96) });
        expect(retry?.zip).toEqual(a?.zip);
        expect(retry?.xmlFileName).toBe(a?.xmlFileName);
        expect(a).not.toBeNull();
        expect(b?.zip).toEqual(a?.zip);
        expect(b?.xmlFileName).toBe(a?.xmlFileName);
        const doc = await db.dianDocument.findUniqueOrThrow({ where: { id: request.documentId } });
        expect(doc.cufe).toBe(request.cude);
        expect(doc.issuedAt).toEqual(request.issuedAt);
        expect(doc.submissionFileName).toBe(a?.xmlFileName);
        expect((await JSZip.loadAsync(a!.zip)).files[a!.xmlFileName]).toBeDefined();
        expect(await db.creditNoteFileSeries.count({ where: { issuerNit } })).toBe(1);
    });
    it('uses one annual counter across restaurants and fiscal prefixes', async () => {
        const a = await fixture(0), b = await fixture(1);
        const results = await Promise.all([prepareCreditNotePayload(a), prepareCreditNotePayload(b)]);
        expect(new Set(results.map(r => r?.xmlFileName)).size).toBe(2);
        expect((await db.creditNoteFileSeries.findUniqueOrThrow({ where: { issuerNit_environment_year: { issuerNit, environment: '2', year: 2026 } } })).lastNumber).toBe(3);
    });
    it('atomically creates a previously nonexistent year for two establishments', async () => {
        const a = await fixture(0, new Date('2032-06-01T12:00:00Z')), b = await fixture(1, new Date('2032-06-01T12:00:00Z'));
        const results = await Promise.all([prepareCreditNotePayload(a), prepareCreditNotePayload(b)]);
        expect(new Set(results.map(r => r?.xmlFileName)).size).toBe(2);
        expect((await db.creditNoteFileSeries.findUniqueOrThrow({ where: { issuerNit_environment_year: { issuerNit, environment: '2', year: 2032 } } })).lastNumber).toBe(2);
    });
    it('starts a fresh counter at January1 in Colombia', async () => {
        const a = await prepareCreditNotePayload(await fixture(0, new Date('2027-01-01T04:59:59Z')));
        const b = await prepareCreditNotePayload(await fixture(0, new Date('2027-01-01T05:00:00Z')));
        expect(a?.xmlFileName).toBe(`nc${issuerNit}0002600000004.xml`);
        expect(b?.xmlFileName).toBe(`nc${issuerNit}0002700000001.xml`);
    });
    it('keeps production and habilitation annual counters separate', async () => {
        const request = await fixture(0, new Date('2026-10-02T12:00:00Z'));
        const productionSeries = await db.creditNoteSeries.create({data:{issuerNit,environment:'1',prefix:'PROD'}});
        const doc=await db.dianDocument.findUniqueOrThrow({where:{id:request.documentId}});
        await db.creditNote.update({where:{id:doc.creditNoteId!},data:{seriesId:productionSeries.id,fiscalKey:`${issuerNit}:1:PROD${sequence}`,documentNumber:`PROD${sequence}`}});
        const result=await prepareCreditNotePayload({...request,environment:'1'});
        expect(result?.xmlFileName).toBe(`nc${issuerNit}0002600000001.xml`);
        expect((await db.creditNoteFileSeries.findUniqueOrThrow({where:{issuerNit_environment_year:{issuerNit,environment:'2',year:2026}}})).lastNumber).toBe(4);
    });
    it('rejects wrong tenants, issuers and leases without allocating', async () => {
        const request = await fixture(0, new Date('2028-06-01T12:00:00Z'));
        expect(await prepareCreditNotePayload({ ...request, restaurantId: tenants[1] })).toBeNull();
        expect(await prepareCreditNotePayload({ ...request, leaseToken: randomUUID() })).toBeNull();
        expect(await prepareCreditNotePayload({ ...request, issuerNit: '800197268' })).toBeNull();
        expect(await db.creditNoteFileSeries.count({ where: { issuerNit, year: 2028 } })).toBe(0);
    });
    it('rolls back its counter and payload if its lease expires during ZIP preparation', async () => {
        const request = await fixture(0, new Date('2029-06-01T12:00:00Z'));
        await db.dianDocument.update({ where: { id: request.documentId }, data: { leaseExpiresAt: new Date(Date.now() + 100) } });
        delay.ms = 150;
        expect(await prepareCreditNotePayload(request)).toBeNull();
        expect(await db.creditNoteFileSeries.count({ where: { issuerNit, year: 2029 } })).toBe(0);
        expect(await db.dianDocument.findUniqueOrThrow({ where: { id: request.documentId } })).toMatchObject({ xmlZip: null, cufe: null, issuedAt: null, submissionFileName: null });
    });
    it('blocks exhausted counters without overflow or signing a new payload', async () => {
        await db.creditNoteFileSeries.create({ data: { issuerNit, environment: '2', year: 2030, lastNumber: 2147483647 } });
        const request = await fixture(0, new Date('2030-06-01T12:00:00Z'));
        await expect(prepareCreditNotePayload(request)).rejects.toThrow('file_numbering_exhausted');
        expect((await db.dianDocument.findUniqueOrThrow({ where: { id: request.documentId } })).xmlZip).toBeNull();
    });
    it('returns legacy signed ZIP entries unchanged without assigning a new transport number', async () => {
        const request = await fixture(0, new Date('2031-06-01T12:00:00Z'));
        const legacy = await new JSZip().file('OLD-NC99.xml', '<signed>legacy bytes</signed>').generateAsync({ type: 'nodebuffer' });
        await db.dianDocument.update({ where: { id: request.documentId }, data: { xmlZip: new Uint8Array(legacy), cufe: request.cude, issuedAt: request.issuedAt } });
        const result = await prepareCreditNotePayload(request);
        expect(result).toEqual({ xmlFileName: 'OLD-NC99.xml', zipFileName: 'OLD-NC99.zip', zip: legacy });
        expect(await db.creditNoteFileSeries.count({ where: { issuerNit, year: 2031 } })).toBe(0);
    });
});
