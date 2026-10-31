import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ find:vi.fn(),update:vi.fn(),restaurant:vi.fn(),config:vi.fn(),emisor:vi.fn(),sign:vi.fn(),zip:vi.fn(),status:vi.fn(),statusZip:vi.fn(),send:vi.fn(),testSend:vi.fn(),email:vi.fn(),prepare:vi.fn(),stamp:vi.fn() }));
vi.mock("@/lib/db",()=>({db:{creditNote:{findFirst:m.find},dianDocument:{updateMany:m.update},restaurant:{findUnique:m.restaurant}}}));
vi.mock("./config",async original=>({...await original<typeof import('./config')>(),loadDianConfig:m.config,resolveEmisor:m.emisor}));
vi.mock("./xades",()=>({signXmlDian:m.sign}));
vi.mock("./soap",async original=>({...await original<typeof import('./soap')>(),zipInvoice:m.zip,getStatus:m.status,getStatusZip:m.statusZip,sendBillSync:m.send,sendTestSetAsync:m.testSend}));
vi.mock("./sendCreditNoteEmail",()=>({sendDianCreditNoteEmail:m.email}));
vi.mock("./creditNotePayload",()=>({prepareCreditNotePayload:m.prepare}));
vi.mock("@/lib/erp/creditNoteAccounting",()=>({stampCreditNoteAccounting:m.stamp}));
import { emitDianCreditNote } from "./emitCreditNote";
import { duplicateCreditNoteRule, historicalCreditNoteResponse } from "./__fixtures__/creditNoteResponse";
const now=new Date("2026-10-02T15:00:00Z");
const party={name:"Empresa prueba",companyId:"900373076",dv:"4",idSchemeName:"31",taxLevelCode:"R-99-PN",taxRegimeCode:"49",personType:"1"};
const line={description:"Plato",quantity:1,unitPriceCents:10000,lineTotalCents:10000,taxCents:800,taxPct:"8.00",taxSchemeId:"04",originalLineId:"7",grossCents:10800};
function note(state="to_send",payload=false) {return {id:"note1",restaurantId:"r1",documentNumber:"NC1",reasonCode:"3",reasonText:"Descuento acordado",abandonedAt:null,totalCents:10800,subtotalCents:10000,taxCents:800,series:{prefix:"NC",environment:"1",issuerNit:"900373076"},snapshot:{version:1,locale:"es",brandName:"Prueba",recipientEmail:null,original:{supplier:party,customer:{...party,companyId:"222222222222"},invoiceNumber:"FE1",cufe:"a".repeat(96),issueDate:"2026-09-01",environment:"1",paymentMeansCode:"10",paymentMeansId:"1"},lines:[line]},dianDocument:{id:"doc1",state,cufe:payload?"b".repeat(96):null,xmlZip:payload?Buffer.from("frozen-signed-zip"):null,leaseExpiresAt:null,trackId:null,attempts:payload?1:0,issuedAt:payload?now:null}};}
beforeEach(()=>{vi.resetAllMocks();m.find.mockResolvedValue(note());m.update.mockResolvedValue({count:1});m.restaurant.mockResolvedValue({enabledModules:["einvoicing"]});m.emisor.mockResolvedValue({taxId:"900373076-4"});m.config.mockResolvedValue({environment:"produccion",softwareId:"sw",softwarePin:"pin",cert:{notBefore:new Date("2025-01-01"),notAfter:new Date("2030-01-01")}});m.sign.mockImplementation((xml:string)=>xml+"<!--signed-->");m.zip.mockImplementation(async(_n:string,x:string)=>Buffer.from(x));m.send.mockResolvedValue({state:"accepted",errors:[]});m.email.mockResolvedValue({ok:true});m.stamp.mockResolvedValue(true);m.status.mockResolvedValue({state:"rejected",statusCode:"66",errors:[]});m.prepare.mockImplementation(async input=>{const zip=await m.zip("nc09003730760002600000001.xml",input.signedXml);const saved=await m.update({where:{id:input.documentId,leaseToken:input.leaseToken},data:{xmlZip:zip,cufe:input.cude,issuedAt:input.issuedAt}});return saved.count?{zip,xmlFileName:"nc09003730760002600000001.xml",zipFileName:"z09003730760002600000001.zip"}:null;});});
const emit=(extra={})=>emitDianCreditNote({creditNoteId:"note1",restaurantId:"r1",now,...extra});
describe("credit-note immutable delivery",()=>{
 it("scopes the note to the caller's restaurant",async()=>{m.find.mockResolvedValue(null);expect(await emit()).toEqual({outcome:"not_found"});expect(m.find).toHaveBeenCalledWith(expect.objectContaining({where:{id:"note1",restaurantId:"r1"}}));expect(m.send).not.toHaveBeenCalled();});
 it.each(["accepted","rejected","abandoned"])("never transmits terminal %s",async state=>{m.find.mockResolvedValue(note(state,true));expect((await emit()).outcome).toBe("already_emitted");expect(m.update).not.toHaveBeenCalled();});
 it("does not steal a live lease",async()=>{const n=note();n.dianDocument.leaseExpiresAt=new Date(now.getTime()+1000) as never;m.find.mockResolvedValue(n);expect((await emit()).outcome).toBe("already_emitted");expect(m.send).not.toHaveBeenCalled();});
 it("only winner of the claim can sign/send",async()=>{m.update.mockResolvedValue({count:0});expect((await emit()).outcome).toBe("already_emitted");expect(m.sign).not.toHaveBeenCalled();});
 it("persists signed bytes and issue time BEFORE external delivery",async()=>{m.send.mockImplementation(async(zip:Buffer)=>{const saved=m.update.mock.calls.find(([x])=>x.data.xmlZip)?.[0];expect(saved.data.issuedAt).toEqual(now);expect(Buffer.from(saved.data.xmlZip)).toEqual(zip);expect(saved.data.cufe).toMatch(/^[a-f0-9]{96}$/);return{state:"accepted",errors:[]};});expect((await emit()).outcome).toBe("accepted");expect(m.sign.mock.calls[0][0]).toContain("<cbc:Note>Referencia a la línea original: 7</cbc:Note>");expect(m.email).toHaveBeenCalledWith("note1","r1");expect(m.stamp).toHaveBeenCalledWith("r1","note1");expect(m.send.mock.calls[0][1].fileName).toBe("z09003730760002600000001.zip");});
 it("lost payload persistence prevents external send",async()=>{m.update.mockResolvedValueOnce({count:1}).mockResolvedValueOnce({count:0});expect((await emit()).outcome).toBe("already_emitted");expect(m.send).not.toHaveBeenCalled();});
 it("a stale pre-claim read cannot rebuild a ZIP another worker persisted",async()=>{const latest=note("pending",true);m.update.mockImplementation(async({where})=>({count:where.xmlZip===null&&latest.dianDocument.xmlZip?0:1}));expect((await emit()).outcome).toBe("already_emitted");expect(m.sign).not.toHaveBeenCalled();expect(m.send).not.toHaveBeenCalled();expect(m.update.mock.calls[0][0].where).toMatchObject({cufe:null,xmlZip:null,attempts:0,state:"to_send"});});
 it("uses one Colombian issuance instant for the fiscal XML and signature",async()=>{await emit();const [xml,,options]=m.sign.mock.calls[0];expect(xml).toContain("<cbc:IssueDate>2026-10-02</cbc:IssueDate>");expect(xml).toContain("<cbc:IssueTime>10:00:00-05:00</cbc:IssueTime>");expect(xml).not.toContain("undefined");expect(options.signingTime).toBe("2026-10-02T10:00:00-05:00");});
 it("recovery queries CUDE and reuses exactly the same ZIP",async()=>{m.find.mockResolvedValue(note("error",true));await emit();expect(m.status).toHaveBeenCalledWith("b".repeat(96),expect.anything());expect(m.sign).not.toHaveBeenCalled();expect(m.send.mock.calls[0][0]).toEqual(Buffer.from("frozen-signed-zip"));});
 it("accepted lookup never retransmits",async()=>{m.find.mockResolvedValue(note("error",true));m.status.mockResolvedValue({state:"accepted",cufe:"b".repeat(96),errors:[]});expect((await emit()).outcome).toBe("accepted");expect(m.send).not.toHaveBeenCalled();});
 it("uses a known ZipKey when CUDE lookup is not yet indexed",async()=>{const n=note("pending",true);n.dianDocument.trackId="zip-key" as never;m.find.mockResolvedValue(n);m.statusZip.mockResolvedValue({state:"accepted",errors:[]});expect((await emit()).outcome).toBe("accepted");expect(m.statusZip).toHaveBeenCalledWith("zip-key",expect.anything());expect(m.send).not.toHaveBeenCalled();});
 it("StatusCode90 is not a definitive rejection",async()=>{m.find.mockResolvedValue(note("error",true));m.status.mockResolvedValue({state:"rejected",statusCode:"90",errors:["TrackId no encontrado"]});expect((await emit({mode:"status"})).outcome).toBe("pending");expect(m.send).not.toHaveBeenCalled();});
 it("persists definitive99 rejection without emailing",async()=>{m.send.mockResolvedValue({state:"rejected",statusCode:"99",errors:["Regla: CAV01, Rechazo: detalle inválido"]});expect((await emit()).outcome).toBe("rejected");expect(m.email).not.toHaveBeenCalled();expect(m.stamp).not.toHaveBeenCalled();});
 it("a failed accounting stamp never undoes the fiscal acceptance",async()=>{m.stamp.mockRejectedValue(new Error("db down"));const spy=vi.spyOn(console,"error").mockImplementation(()=>undefined);expect((await emit()).outcome).toBe("accepted");expect(m.email).toHaveBeenCalled();spy.mockRestore();});
 it("status-only lookup cannot create or transmit",async()=>{m.find.mockResolvedValue(note("pending",true));expect((await emit({mode:"status"})).outcome).toBe("pending");expect(m.send).not.toHaveBeenCalled();expect(m.sign).not.toHaveBeenCalled();});
 it("duplicate rule 90 stays pending, preserving its fiscal reservation",async()=>{m.send.mockResolvedValue({state:"rejected",statusCode:"99",errors:["Regla: 90, documento procesado anteriormente"]});expect((await emit()).outcome).toBe("pending");expect(m.update.mock.calls.at(-1)?.[0].data.state).toBe("pending");});
 it("transport exception keeps signed bytes and only sanitized error",async()=>{m.send.mockRejectedValue(new Error("SECRET"));expect((await emit()).outcome).toBe("error");const final=m.update.mock.calls.at(-1)?.[0];expect(final.data.lastError).toBe("transport_error");expect(JSON.stringify(final)).not.toContain("SECRET");expect(final.data.xmlZip).toBeUndefined();});
 it("a stale worker cannot finalize or send customer mail",async()=>{m.update.mockImplementation(async x=>({count:x.data.state==="accepted"?0:1}));expect((await emit()).outcome).toBe("already_emitted");expect(m.email).not.toHaveBeenCalled();for(const [arg] of m.update.mock.calls.slice(1))expect(arg.where.leaseToken).toBeTruthy();});
 it.each([["module_disabled",()=>m.restaurant.mockResolvedValue({enabledModules:[]})],["issuer_changed",()=>m.emisor.mockResolvedValue({taxId:"123456789"})],["environment_changed",()=>m.config.mockResolvedValue({environment:"habilitacion"})],["certificate_expired",()=>m.config.mockResolvedValue({environment:"produccion",cert:{notBefore:new Date(0),notAfter:new Date(1)}})]])("blocks %s before signing",async(reason,setup)=>{(setup as ()=>void)();expect(await emit()).toMatchObject({outcome:"blocked",reason});expect(m.sign).not.toHaveBeenCalled();expect(m.send).not.toHaveBeenCalled();});
 it("rejects acceptance of a different CUDE",async()=>{m.find.mockResolvedValue(note("error",true));m.status.mockResolvedValue({state:"accepted",cufe:"c".repeat(96),errors:[]});expect((await emit()).outcome).toBe("error");expect(m.email).not.toHaveBeenCalled();});
 it("does not reinterpret unavailable lookup as a fiscal rejection",async()=>{m.find.mockResolvedValue(note("error",true));m.status.mockResolvedValue({state:"error",errors:["timeout"]});expect((await emit()).outcome).toBe("error");expect(m.send).not.toHaveBeenCalled();});
});

describe('historical credit-note numbering collision', () => {
 const collisionNote = () => { const n = note('error', true); return { ...n, dianDocument: { ...n.dianDocument, lastError: 'dian_numbering_conflict', errors: ['dian_numbering_conflict', duplicateCreditNoteRule], responseXml: historicalCreditNoteResponse().raw } }; };
 const finalWrite = () => m.update.mock.calls.at(-1)?.[0].data;
 it('keeps the original rejection and pauses a newly detected foreign NC1 without mail or accounting', async () => {
   m.find.mockResolvedValue(note('error', true)); m.send.mockResolvedValue(historicalCreditNoteResponse());
   expect(await emit()).toMatchObject({ outcome: 'error', errors: ['dian_numbering_conflict', duplicateCreditNoteRule] });
   expect(finalWrite()).toMatchObject({ state: 'error', lastError: 'dian_numbering_conflict', nextAttemptAt: null, responseXml: historicalCreditNoteResponse().raw });
   expect(finalWrite()).not.toHaveProperty('cufe'); expect(finalWrite()).not.toHaveProperty('xmlZip');
   expect(m.email).not.toHaveBeenCalled(); expect(m.stamp).not.toHaveBeenCalled();
 });
 it.each(['dian_numbering_conflict', 'response_identifier_mismatch'])('does not query or resend a stored collision on automatic/manual emit: %s', async lastError => {
   const n = collisionNote(); m.find.mockResolvedValue({ ...n, dianDocument: { ...n.dianDocument, lastError } });
   expect(await emit()).toMatchObject({ outcome: 'blocked', reason: 'dian_numbering_conflict' });
   expect(m.status).not.toHaveBeenCalled(); expect(m.send).not.toHaveBeenCalled(); expect(m.sign).not.toHaveBeenCalled();
   expect(finalWrite()).toMatchObject({ lastError: 'dian_numbering_conflict', nextAttemptAt: null });
 });
 it.each([
   { state: 'rejected', statusCode: '66', errors: [] },
   { state: 'rejected', statusCode: '90', errors: ['TrackId not found'] },
   { state: 'pending', errors: [] },
   { state: 'accepted', errors: [] },
   { state: 'accepted', cufe: 'c'.repeat(96), errors: [] },
   { state: 'error', errors: ['timeout'] },
 ])('status-only uncertainty retains collision evidence and reservation: %j', async result => {
   m.find.mockResolvedValue(collisionNote()); m.status.mockResolvedValue(result);
   expect(await emit({ mode: 'status' })).toMatchObject({ outcome: 'blocked', reason: 'dian_numbering_conflict' });
   expect(finalWrite()).toMatchObject({ state: 'error', lastError: 'dian_numbering_conflict', errors: ['dian_numbering_conflict', duplicateCreditNoteRule] });
   expect(finalWrite().responseXml).toBeUndefined(); expect(m.send).not.toHaveBeenCalled(); expect(m.email).not.toHaveBeenCalled(); expect(m.stamp).not.toHaveBeenCalled();
 });
 it('does not erase collision evidence after a thrown transport error', async () => {
   m.find.mockResolvedValue(collisionNote()); m.status.mockRejectedValue(new Error('SECRET'));
   expect(await emit({ mode: 'status' })).toMatchObject({ outcome: 'blocked', reason: 'dian_numbering_conflict' });
   expect(finalWrite()).toMatchObject({ lastError: 'dian_numbering_conflict' }); expect(finalWrite().responseXml).toBeUndefined();
   expect(JSON.stringify(finalWrite())).not.toContain('SECRET');
 });
 it('allows reconciliation only after explicit status returns acceptance of the exact stored CUDE', async () => {
   m.find.mockResolvedValue(collisionNote()); m.status.mockResolvedValue({ state: 'accepted', cufe: 'b'.repeat(96), errors: [], raw: '<matching-response/>' });
   expect(await emit({ mode: 'status' })).toMatchObject({ outcome: 'accepted' });
   expect(finalWrite()).toMatchObject({ state: 'accepted', lastError: null, responseXml: '<matching-response/>' });
   expect(m.send).not.toHaveBeenCalled(); expect(m.email).toHaveBeenCalledOnce();
 });
 it('allows a definitive rejection only when it belongs to the exact stored CUDE', async () => {
   m.find.mockResolvedValue(collisionNote()); m.status.mockResolvedValue({ state: 'rejected', statusCode: '99', cufe: 'b'.repeat(96), errors: ['Regla: CAV01, detalle inválido'], raw: '<matching-rejection/>' });
   expect(await emit({ mode: 'status' })).toMatchObject({ outcome: 'rejected' });
   expect(finalWrite()).toMatchObject({ state: 'rejected', lastError: null, responseXml: '<matching-rejection/>' });
   expect(m.send).not.toHaveBeenCalled(); expect(m.email).not.toHaveBeenCalled(); expect(m.stamp).not.toHaveBeenCalled();
 });
 it('cannot overwrite a newer result if its lease is lost while preserving the collision', async () => {
   m.find.mockResolvedValue(collisionNote()); m.update.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
   expect(await emit()).toEqual({ outcome: 'already_emitted' });
   expect(m.update.mock.calls[1][0].where.leaseToken).toBe(m.update.mock.calls[0][0].data.leaseToken);
   expect(m.status).not.toHaveBeenCalled(); expect(m.send).not.toHaveBeenCalled(); expect(m.email).not.toHaveBeenCalled();
 });
 it('a configuration problem cannot overwrite the original collision evidence', async () => {
   m.find.mockResolvedValue(collisionNote()); m.restaurant.mockResolvedValue({ enabledModules: [] });
   expect(await emit({ mode: 'status' })).toMatchObject({ outcome: 'blocked', reason: 'dian_numbering_conflict' });
   expect(finalWrite()).toMatchObject({ state: 'error', lastError: 'dian_numbering_conflict' });
   expect(finalWrite().responseXml).toBeUndefined(); expect(m.status).not.toHaveBeenCalled();
 });
});

describe('«No recibida por la DIAN» (66 persistente)', () => {
 const day = 24 * 60 * 60_000;
 const cude = 'b'.repeat(96);
 const notFound66 = () => ({ state: 'rejected' as const, statusCode: '66', statusMessage: 'TrackId no existe en los registros de la DIAN.', errors: [], raw: '<status-66/>' });
 // NC1: firmada hace 18 días, 8 envíos, sin ZipKey (SendBillSync no lo da).
 const nc1 = (over: Record<string, unknown> = {}) => { const n = note('pending', true); return { ...n, dianDocument: { ...n.dianDocument, attempts: 8, issuedAt: new Date(now.getTime() - 18 * day), lastError: null, errors: [], statusNotFoundCount: 0, ...over } }; };
 const finalWrite = () => m.update.mock.calls.at(-1)?.[0].data;
 beforeEach(() => { m.status.mockResolvedValue(notFound66()); });
 it('consulta por CUDE: un trackId vacío o en blanco nunca se usa', async () => {
   for (const trackId of [null, '', '   ']) {
     m.status.mockClear(); m.statusZip.mockClear(); m.find.mockResolvedValue(nc1({ trackId }));
     await emit({ mode: 'status' });
     expect(m.status).toHaveBeenCalledWith(cude, expect.anything());
     expect(m.statusZip).not.toHaveBeenCalled();
   }
 });
 it('las dos primeras respuestas 66 dejan la nota pendiente y suman la racha', async () => {
   m.find.mockResolvedValue(nc1({ statusNotFoundCount: 1 }));
   expect(await emit({ mode: 'status' })).toMatchObject({ outcome: 'pending' });
   expect(finalWrite()).toMatchObject({ state: 'pending', lastError: null, statusNotFoundCount: 2 });
   expect(finalWrite().nextAttemptAt).toBeInstanceOf(Date);
   expect(m.send).not.toHaveBeenCalled();
 });
 it('la tercera 66 seguida, pasadas 24 h, la marca no recibida y saca la nota del barrido', async () => {
   m.find.mockResolvedValue(nc1({ statusNotFoundCount: 2 }));
   expect(await emit({ mode: 'status' })).toMatchObject({ outcome: 'error', errors: ['dian_not_received'] });
   expect(finalWrite()).toMatchObject({ state: 'error', lastError: 'dian_not_received', errors: ['dian_not_received'], nextAttemptAt: null, statusNotFoundCount: 3, responseXml: '<status-66/>' });
   expect(m.send).not.toHaveBeenCalled(); expect(m.email).not.toHaveBeenCalled(); expect(m.stamp).not.toHaveBeenCalled();
 });
 it('antes de 24 h desde la emisión no la marca, aunque la racha supere el umbral', async () => {
   m.find.mockResolvedValue(nc1({ statusNotFoundCount: 5, issuedAt: new Date(now.getTime() - day + 60_000) }));
   expect(await emit({ mode: 'status' })).toMatchObject({ outcome: 'pending' });
   expect(finalWrite()).toMatchObject({ state: 'pending', statusNotFoundCount: 6 });
 });
 it('mientras quedan reenvíos (emit) retransmite los mismos bytes en vez de marcarla', async () => {
   m.find.mockResolvedValue(nc1({ attempts: 2, statusNotFoundCount: 4 })); m.send.mockResolvedValue({ state: 'error', errors: ['la DIAN no respondió'] });
   await emit();
   expect(m.send.mock.calls[0][0]).toEqual(Buffer.from('frozen-signed-zip'));
   expect(finalWrite()).toMatchObject({ state: 'error', statusNotFoundCount: 5 });
 });
 it('cualquier otra respuesta de la DIAN reinicia la racha', async () => {
   m.find.mockResolvedValue(nc1({ attempts: 2, statusNotFoundCount: 2 })); m.send.mockResolvedValue({ state: 'rejected', statusCode: '99', errors: ['Regla: 90, documento procesado anteriormente'] });
   await emit();
   expect(finalWrite()).toMatchObject({ state: 'pending', statusNotFoundCount: 0 });
   m.find.mockResolvedValue(nc1({ statusNotFoundCount: 2 })); m.status.mockResolvedValue({ state: 'pending', statusMessage: 'Batch en proceso de validación.', errors: [] });
   await emit({ mode: 'status' });
   expect(finalWrite()).toMatchObject({ state: 'pending', statusNotFoundCount: 0 });
 });
 it('un fallo de canal en la consulta no suma ni reinicia la racha', async () => {
   m.find.mockResolvedValue(nc1({ statusNotFoundCount: 2 })); m.status.mockResolvedValue({ state: 'error', errors: ['The operation was aborted due to timeout'] });
   await emit({ mode: 'status' });
   expect(finalWrite()).toMatchObject({ state: 'error', statusNotFoundCount: 2 });
   expect(finalWrite().lastError).not.toBe('dian_not_received');
 });
 describe('una vez no recibida', () => {
   const notReceived = (over: Record<string, unknown> = {}) => nc1({ state: 'error', lastError: 'dian_not_received', errors: ['dian_not_received'], statusNotFoundCount: 3, ...over });
   it('si la DIAN dice que SÍ la tiene (mismo CUDE), gana la DIAN', async () => {
     m.find.mockResolvedValue(notReceived()); m.status.mockResolvedValue({ state: 'accepted', cufe: cude, errors: [], raw: '<accepted/>' });
     expect(await emit({ mode: 'status' })).toMatchObject({ outcome: 'accepted' });
     expect(finalWrite()).toMatchObject({ state: 'accepted', lastError: null, statusNotFoundCount: 0, nextAttemptAt: null });
     expect(m.send).not.toHaveBeenCalled(); expect(m.stamp).toHaveBeenCalledWith('r1', 'note1');
   });
   it('si la DIAN la rechaza de forma definitiva, queda rechazada', async () => {
     m.find.mockResolvedValue(notReceived()); m.status.mockResolvedValue({ state: 'rejected', statusCode: '99', cufe: cude, errors: ['Regla: CAV01, detalle'] });
     expect(await emit({ mode: 'status' })).toMatchObject({ outcome: 'rejected' });
     expect(finalWrite()).toMatchObject({ state: 'rejected', statusNotFoundCount: 0 });
   });
   it('otra 66 la mantiene no recibida', async () => {
     m.find.mockResolvedValue(notReceived());
     await emit({ mode: 'status' });
     expect(finalWrite()).toMatchObject({ state: 'error', lastError: 'dian_not_received', statusNotFoundCount: 4, nextAttemptAt: null });
   });
   it('un fallo de canal o de configuración no borra la evidencia', async () => {
     m.find.mockResolvedValue(notReceived()); m.status.mockResolvedValue({ state: 'error', errors: ['la DIAN no respondió'] });
     expect(await emit({ mode: 'status' })).toMatchObject({ outcome: 'error', errors: ['dian_not_received'] });
     expect(finalWrite()).toMatchObject({ state: 'error', lastError: 'dian_not_received', nextAttemptAt: null });
     m.status.mockRejectedValue(new Error('SECRET'));
     await emit({ mode: 'status' });
     expect(finalWrite()).toMatchObject({ lastError: 'dian_not_received' }); expect(JSON.stringify(finalWrite())).not.toContain('SECRET');
     m.config.mockResolvedValue({ environment: 'produccion', cert: { notBefore: new Date(0), notAfter: new Date(1) } });
     expect(await emit({ mode: 'status' })).toMatchObject({ outcome: 'blocked', reason: 'certificate_expired' });
     expect(finalWrite()).toMatchObject({ lastError: 'dian_not_received', nextAttemptAt: null });
   });
   it('el reenvío manual (emit) retransmite los mismos bytes', async () => {
     m.find.mockResolvedValue(notReceived()); m.send.mockResolvedValue({ state: 'accepted', cufe: cude, errors: [] });
     expect(await emit()).toMatchObject({ outcome: 'accepted' });
     expect(m.send.mock.calls[0][0]).toEqual(Buffer.from('frozen-signed-zip')); expect(m.sign).not.toHaveBeenCalled();
   });
 });
});

describe('rechazo definitivo frente a error de canal', () => {
 it('un 5xx, un Fault o un timeout del envío quedan como error transitorio, no descartable', async () => {
   const { canAbandon } = await import('./creditNotes/domain');
   for (const sent of [{ state: 'error' as const, errors: ['la DIAN no respondió'] }, { state: 'error' as const, statusCode: 'a:InvalidSecurity', errors: ['a:InvalidSecurity: rechazado'] }, { state: 'error' as const, errors: ['respuesta no reconocida de la DIAN'], raw: '<html>503</html>' }]) {
     m.update.mockClear(); m.find.mockResolvedValue(note('error', true)); m.send.mockResolvedValue(sent);
     expect((await emit()).outcome).toBe('error');
     const data = m.update.mock.calls.at(-1)?.[0].data;
     expect(data.nextAttemptAt).toBeInstanceOf(Date);
     expect(canAbandon({ state: data.state, xmlZip: Buffer.from('x'), attempts: 2, leaseExpiresAt: null, lastError: data.lastError, responseXml: data.responseXml ?? null }, null)).toBe(false);
   }
 });
 it('IsValid=false + 99 propio queda rechazada y descartable', async () => {
   const { canAbandon } = await import('./creditNotes/domain');
   m.send.mockResolvedValue({ state: 'rejected', statusCode: '99', errors: ['Regla: CAV01, Rechazo: detalle inválido'] });
   expect((await emit()).outcome).toBe('rejected');
   const data = m.update.mock.calls.at(-1)?.[0].data;
   expect(canAbandon({ state: data.state, xmlZip: Buffer.from('x'), attempts: 1, leaseExpiresAt: null, lastError: data.lastError }, null)).toBe(true);
 });
});
