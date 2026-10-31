import { historicalCreditNoteResponse } from './creditNoteResponse';

// Datos sintéticos que reproducen los TRES casos reales de la serie en
// conflicto (sin NIT, CUDE ni respuestas de producción):
// - NC1: firmada, la DIAN responde 66 «TrackId no existe» una y otra vez.
// - NC3: rechazo definitivo regla 90 (número usado por otro sistema del NIT).
// - NCM1: la reemisión aceptada en la serie sin conflicto.
const issuedAt = new Date('2026-10-13T15:00:00Z');
const signed = { xmlZip: Buffer.from('frozen-signed-zip'), issuedAt, leaseExpiresAt: null, trackId: null };

export const notFoundStatusResponse = '<Envelope><Body><GetStatusResponse><GetStatusResult><IsValid>false</IsValid><StatusCode>66</StatusCode><StatusDescription>TrackId no existe en los registros de la DIAN.</StatusDescription><XmlDocumentKey i:nil="true"/></GetStatusResult></GetStatusResponse></Body></Envelope>';
export const soapFaultResponse = '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><s:Fault><s:Code><s:Value>s:Sender</s:Value><s:Subcode><s:Value>a:InvalidSecurity</s:Value></s:Subcode></s:Code><s:Reason><s:Text>An error occurred when verifying security for the message.</s:Text></s:Reason></s:Fault></s:Body></s:Envelope>';
export const gatewayErrorResponse = '<html><body><h1>503 Service Unavailable</h1></body></html>';

export const nc1Pending = { ...signed, state: 'pending', cufe: '1'.repeat(96), attempts: 8, lastError: null, errors: [], responseXml: notFoundStatusResponse, statusNotFoundCount: 0 };
export const nc1NotReceived = { ...nc1Pending, state: 'error', lastError: 'dian_not_received', errors: ['dian_not_received'], statusNotFoundCount: 3, nextAttemptAt: null };
export const nc3Conflict = { ...signed, state: 'error', cufe: 'b'.repeat(96), attempts: 1, lastError: 'dian_numbering_conflict', errors: ['dian_numbering_conflict', 'Regla: 90, Rechazo: Documento procesado anteriormente.'], responseXml: historicalCreditNoteResponse({ documentNumber: 'NC3' }).raw!, statusNotFoundCount: 0 };
export const ncm1Accepted = { ...signed, state: 'accepted', cufe: 'e'.repeat(96), attempts: 1, lastError: null, errors: [], responseXml: '<Envelope><Body><SendBillSyncResponse><SendBillSyncResult><IsValid>true</IsValid><StatusCode>00</StatusCode></SendBillSyncResult></SendBillSyncResponse></Body></Envelope>', statusNotFoundCount: 0 };
