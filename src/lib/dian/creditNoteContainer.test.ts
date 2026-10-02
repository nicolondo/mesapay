import { generateKeyPairSync } from 'node:crypto';
import forge from 'node-forge';
import { beforeAll, describe, expect, it } from 'vitest';
import { SignedXml } from 'xml-crypto';
import { DOMParser } from '@xmldom/xmldom';
import { buildSignedCreditNoteContainer } from './creditNoteContainer';
import { assertAcceptedCreditNote } from './creditNotePresentation';
import { buildDianCreditNoteXml } from './creditNote';
import { originalInvoiceInput } from './__fixtures__/creditNote';
import { presentationFixture } from './__fixtures__/creditNotePresentation';
import type { LoadedCert } from './crypto';
import { sendBillSync, sendTestSetAsync } from './soap';
let cert: LoadedCert;
beforeAll(() => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const c = forge.pki.createCertificate();
  c.publicKey = forge.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' }).toString());
  c.serialNumber = '01'; c.validity.notBefore = new Date('2026-01-01'); c.validity.notAfter = new Date('2030-01-01');
  const attrs = [{ name: 'commonName', value: 'EPHEMERAL TEST ONLY' }]; c.setSubject(attrs); c.setIssuer(attrs);
  c.sign(forge.pki.privateKeyFromPem(keyPem), forge.md.sha256.create());
  cert = { keyPem, certPem: forge.pki.certificateToPem(c), certDerBase64: forge.util.encode64(forge.asn1.toDer(forge.pki.certificateToAsn1(c)).getBytes()), subject: 'CN=TEST', issuer: 'CN=TEST', notBefore: c.validity.notBefore, notAfter: c.validity.notAfter };
});
const built = buildDianCreditNoteXml({ ...originalInvoiceInput, invoiceNumber: 'NC1', discrepancyCode: '2', reference: { invoiceNumber: 'FE1', cufe: 'a'.repeat(96), issueDate: '2026-10-01' } });
const note = assertAcceptedCreditNote({ ...presentationFixture, dianDocument: { ...presentationFixture.dianDocument, cufe: built.cufe } });
const response = `<ApplicationResponse xmlns="urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"><cbc:IssueDate>2026-10-03</cbc:IssueDate><cbc:IssueTime>01:00:00-05:00</cbc:IssueTime><cac:DocumentResponse><cac:Response><cbc:ResponseCode>02</cbc:ResponseCode></cac:Response><cac:DocumentReference><cbc:UUID>${built.cufe}</cbc:UUID></cac:DocumentReference></cac:DocumentResponse></ApplicationResponse>`;
describe('signed, immutable AttachedDocument for NC', () => {
  it('sends the immutable DIAN archive name in both SOAP submission operations', async () => {
    const fileName = 'z0800197268000260000000B.zip';
    const envelopes: string[] = [];
    const args = {environment: 'habilitacion' as const, cert, fileName, transport: async (_url: string, _action: string, envelope: string) => {
      envelopes.push(envelope);
      return {status: 200, body: '<Response><IsValid>true</IsValid></Response>'};
    }};
    await sendBillSync(Buffer.from('immutable-zip'), args);
    await sendTestSetAsync(Buffer.from('immutable-zip'), 'test-only-set', args);
    expect(envelopes).toHaveLength(2);
    for (const envelope of envelopes) expect(envelope).toContain(`<wcf:fileName>${fileName}</wcf:fileName>`);
    envelopes.length = 0;
    await sendBillSync(Buffer.from('invoice'), {...args, fileName: undefined});
    expect(envelopes[0]).toContain('<wcf:fileName>invoice.zip</wcf:fileName>');
  });
  it('has official profile, CUDE and signature; envelope never predates DIAN response', () => {
    const signed = buildSignedCreditNoteContainer(note, built.xml, response, cert, new Date('2026-10-02T16:00:00Z'));
    expect(signed).toContain('<cbc:CustomizationID>Documentos adjuntos</cbc:CustomizationID>');
    expect(signed).toContain('schemeName="CUDE-SHA384"');
    expect(signed).toContain('<cbc:IssueDate>2026-10-03</cbc:IssueDate>');
    expect(signed).toContain('<xades:SigningTime>2026-10-03T01:00:00-05:00</xades:SigningTime>');
    const doc = new DOMParser().parseFromString(signed, 'text/xml');
    const signature = doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature')[0];
    const verifier = new SignedXml({ publicCert: cert.certPem }); verifier.loadSignature(signature as never);
    expect(verifier.checkSignature(signed)).toBe(true);
  });
  it('rejects an unrelated DIAN response', () => {
    expect(() => buildSignedCreditNoteContainer(note, built.xml, response.replace(built.cufe, 'f'.repeat(96)), cert)).toThrow('incomplete_document');
  });
  it('rejects a conflicting reference number or a rejection response', () => {
    expect(() => buildSignedCreditNoteContainer(note, built.xml, response.replace('<cac:DocumentReference>', '<cac:DocumentReference><cbc:ID>OTHER</cbc:ID>'), cert)).toThrow('incomplete_document');
    expect(() => buildSignedCreditNoteContainer(note, built.xml, response.replace('>02</cbc:ResponseCode>', '>04</cbc:ResponseCode>'), cert)).toThrow('incomplete_document');
  });
  it('rejects expired certificates and leaves existing frozen delivery independent', () => {
    expect(() => buildSignedCreditNoteContainer(note, built.xml, response, { ...cert, notAfter: new Date('2025-01-01') })).toThrow('certificate_expired');
  });
});
