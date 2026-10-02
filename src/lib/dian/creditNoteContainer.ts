import { DOMParser, XMLSerializer, type Element } from '@xmldom/xmldom';
import { buildAttachedDocumentXml } from './attachedDocument';
import { signXmlDian } from './xades';
import { dianIssueDateTime, dianSigningTime } from './dianDateTime';
import type { LoadedCert } from './crypto';
import type { AcceptedCreditNote } from './creditNotePresentation';
const CBC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';
const CAC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2';
const STS = 'dian:gov:co:facturaelectronica:Structures-2-1';
function root(xml: string, name: 'CreditNote' | 'ApplicationResponse'): Element {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('incomplete_document');
  const doc = new DOMParser({ onError: () => { throw new Error('incomplete_document'); } }).parseFromString(xml, 'application/xml');
  const element = doc.documentElement;
  if (!element || element.localName !== name || element.namespaceURI !== `urn:oasis:names:specification:ubl:schema:xsd:${name}-2`) throw new Error('incomplete_document');
  return element;
}
function direct(element: Element, name: string): string {
  const values = Array.from(element.childNodes).filter((n) => n.nodeType === 1 && (n as Element).namespaceURI === CBC && n.localName === name);
  if (values.length !== 1 || !values[0].textContent?.trim()) throw new Error('incomplete_document');
  return values[0].textContent.trim();
}
export function buildSignedCreditNoteContainer(
  note: AcceptedCreditNote, xml: string, applicationResponse: string, cert: LoadedCert, now = new Date(),
): string {
  const credit = root(xml, 'CreditNote');
  const response = root(applicationResponse, 'ApplicationResponse');
  if (direct(credit, 'UUID') !== note.dianDocument.cufe || direct(credit, 'ID') !== note.documentNumber) throw new Error('incomplete_document');
  const directAggregate = (element: Element, name: string): Element => {
    const found = Array.from(element.childNodes).filter((n): n is Element => n.nodeType === 1 && (n as Element).namespaceURI === CAC && n.localName === name);
    if (found.length !== 1) throw new Error('incomplete_document');
    return found[0];
  };
  const documentResponse = directAggregate(response, 'DocumentResponse');
  const reference = directAggregate(documentResponse, 'DocumentReference');
  const referenceIds = Array.from(reference.childNodes).filter((n) => n.nodeType === 1 && (n as Element).namespaceURI === CBC && n.localName === 'ID');
  if (referenceIds.length > 1 || (referenceIds.length === 1 && referenceIds[0].textContent?.trim() !== note.documentNumber)) throw new Error('incomplete_document');
  if (direct(reference, 'UUID') !== note.dianDocument.cufe || direct(directAggregate(documentResponse, 'Response'), 'ResponseCode') !== '02') throw new Error('incomplete_document');
  const issueDate = direct(credit, 'IssueDate'), issueTime = direct(credit, 'IssueTime');
  const issuedAt = new Date(`${issueDate}T${issueTime}`);
  const validationDate = direct(response, 'IssueDate'), validationTime = direct(response, 'IssueTime');
  const validatedAt = new Date(`${validationDate}T${validationTime}`);
  if (!Number.isFinite(issuedAt.getTime()) || !Number.isFinite(validatedAt.getTime()) || Math.abs(issuedAt.getTime() - note.dianDocument.issuedAt.getTime()) >= 1000) throw new Error('incomplete_document');
  const extensions = credit.getElementsByTagNameNS(STS, 'DianExtensions');
  if (extensions.length !== 1) throw new Error('incomplete_document');
  // The envelope cannot predate either of its contained documents (AE05).
  const containerAt = new Date(Math.max(now.getTime(), issuedAt.getTime(), validatedAt.getTime()));
  if (cert.notBefore > containerAt || cert.notAfter <= containerAt) throw new Error('certificate_expired');
  const instant = dianIssueDateTime(containerAt);
  const unsigned = buildAttachedDocumentXml({
    documentKind: 'credit_note', dianExtensionsXml: new XMLSerializer().serializeToString(extensions[0]),
    environment: note.snapshot.original.environment, invoiceNumber: note.documentNumber,
    issueDate: instant.date, issueTime: instant.time, cufe: note.dianDocument.cufe,
    sender: note.snapshot.original.supplier, receiver: note.snapshot.original.customer,
    invoiceXml: xml, applicationResponseXml: applicationResponse, validationDate, validationTime,
  });
  return signXmlDian(unsigned, cert, { signingTime: dianSigningTime(containerAt) });
}
