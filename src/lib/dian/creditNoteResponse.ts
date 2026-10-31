import { DOMParser, type Element } from '@xmldom/xmldom';
import { extractApplicationResponse, parseDianResponse, type DianResult } from './soap';
import { CREDIT_NOTE_NOT_RECEIVED, CREDIT_NOTE_NUMBERING_CONFLICT, isCreditNoteIdentityError } from './creditNoteDeliveryState';
import type { CreditNoteFailure } from './creditNotes/types';

type CreditNoteIdentity = { documentNumber: string; issuerNit: string; environment: string; cude: string | null };
const CBC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';
const CAC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2';
const MAX_RESPONSE_LENGTH = 2_000_000;
export const creditNoteHash = (value: string | null | undefined) => value?.trim().toLowerCase() ?? '';
// ErrorMessage rule 90 is a duplicate, NOT StatusCode 90 (missing TrackId).
export const isDuplicateCreditNoteResponse = (result: DianResult) => result.errors.some(error => /(?:regla\s*:?\s*90\b|procesad[oa].*anterior|already\s+process)/i.test(error));

function direct(element: Element, namespace: string, name: string): Element {
  const nodes = Array.from(element.childNodes).filter((node): node is Element => node.nodeType === 1 && (node as Element).namespaceURI === namespace && node.localName === name);
  if (nodes.length !== 1) throw new Error('ambiguous_response');
  return nodes[0];
}
const value = (element: Element, name: string) => direct(element, CBC, name).textContent?.trim() ?? '';
const partyId = (element: Element, name: string) => value(direct(direct(element, CAC, name), CAC, 'PartyTaxScheme'), 'CompanyID');

async function hasNumberingCollision(result: DianResult, identity: CreditNoteIdentity): Promise<boolean> {
  if (result.state !== 'rejected' || result.statusCode?.trim() !== '99' || !isDuplicateCreditNoteResponse(result) || !result.raw || result.raw.length > MAX_RESPONSE_LENGTH) return false;
  if (!/^[a-f0-9]{96}$/.test(creditNoteHash(result.cufe)) || !/^[a-f0-9]{96}$/.test(creditNoteHash(identity.cude))) return false;
  try {
    if (/<!DOCTYPE|<!ENTITY/i.test(result.raw)) return false;
    const xml = await extractApplicationResponse(result.raw);
    if (!xml || xml.length > MAX_RESPONSE_LENGTH || /<!DOCTYPE|<!ENTITY/i.test(xml)) return false;
    const root = new DOMParser({ onError: () => { throw new Error('invalid_response'); } }).parseFromString(xml, 'application/xml').documentElement;
    if (!root || root.localName !== 'ApplicationResponse' || root.namespaceURI !== 'urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2') return false;
    const response = direct(root, CAC, 'DocumentResponse');
    const reference = direct(response, CAC, 'DocumentReference');
    // The UUID of the ApplicationResponse itself is NOT the document CUDE.
    // This only diagnoses a collision; it cannot accept or release this note.
    return value(root, 'ProfileExecutionID') === identity.environment
      && partyId(root, 'SenderParty') === '800197268'
      && partyId(root, 'ReceiverParty') === identity.issuerNit
      && value(reference, 'ID') === identity.documentNumber
      && creditNoteHash(value(reference, 'UUID')) === creditNoteHash(result.cufe)
      && value(direct(response, CAC, 'Response'), 'ResponseCode') === '02';
  } catch {
    // Ambiguous XML remains an identifier mismatch, never a fiscal rejection.
    return false;
  }
}

/** Keep the local CUDE authoritative and preserve DIAN rules for diagnosis. */
export async function diagnoseCreditNoteResponse(result: DianResult, identity: CreditNoteIdentity): Promise<DianResult> {
  if (!result.cufe || creditNoteHash(result.cufe) === creditNoteHash(identity.cude)) return result;
  const code = await hasNumberingCollision(result, identity) ? 'dian_numbering_conflict' : 'response_identifier_mismatch';
  return { ...result, state: 'error', errors: [...new Set([code, ...result.errors])] };
}

/** Upgrade legacy diagnostics from saved evidence, without contacting DIAN. */
export async function storedCreditNoteIdentityFailure(document: {
  lastError?: string | null; errors?: unknown; responseXml?: string | null;
}, identity: CreditNoteIdentity): Promise<DianResult | null> {
  if (document.responseXml && document.responseXml.length <= MAX_RESPONSE_LENGTH && !/<!DOCTYPE|<!ENTITY/i.test(document.responseXml)) {
    try {
      const result = await diagnoseCreditNoteResponse({ ...parseDianResponse(document.responseXml), raw: document.responseXml }, identity);
      if (isCreditNoteIdentityError(result.errors[0])) return result;
    } catch { /* Keep the persisted failure if the saved response cannot be read. */ }
  }
  const errors = Array.isArray(document.errors) ? document.errors.filter((error): error is string => typeof error === 'string') : [];
  const code = [document.lastError, ...errors].find(isCreditNoteIdentityError);
  return code ? { state: 'error', errors: [...new Set([code, ...errors])], raw: document.responseXml ?? undefined } : null;
}

/**
 * ¿La respuesta DIAN guardada es un rechazo definitivo? IsValid=false con
 * StatusCode 99: la DIAN validó el envío y no tiene ese documento como
 * válido. Un Fault SOAP, un 5xx, un timeout o una respuesta ilegible no lo
 * son: no dicen nada sobre el documento.
 */
export function isDefinitiveDianRejection(responseXml: string | null | undefined): boolean {
  if (!responseXml || responseXml.length > MAX_RESPONSE_LENGTH || /<!DOCTYPE|<!ENTITY/i.test(responseXml)) return false;
  if (!/<(?:[\w-]+:)?IsValid>\s*false\s*<\//i.test(responseXml)) return false;
  try {
    const parsed = parseDianResponse(responseXml);
    return parsed.state === 'rejected' && parsed.statusCode?.trim() === '99';
  } catch {
    return false;
  }
}

/**
 * Por qué una nota firmada quedó sin salida, o null si su estado todavía
 * puede cambiar solo (envío incierto, error de canal, pendiente). Es la
 * única fuente de verdad para descartar, para el texto del detalle y para
 * el barrido; lee lo que ya está guardado, sin contactar a la DIAN.
 */
export function creditNoteFailure(document: {
  state: string; lastError?: string | null; responseXml?: string | null;
} | null | undefined): CreditNoteFailure | null {
  if (!document) return null;
  if (document.state === 'rejected') return 'dian_rejected';
  if (document.state !== 'error') return null;
  // Ya verificado contra el acuse: mismo número, emisor y ambiente, IsValid=false, 99, regla 90.
  if (document.lastError === CREDIT_NOTE_NUMBERING_CONFLICT) return 'numbering_conflict';
  if (document.lastError === CREDIT_NOTE_NOT_RECEIVED) return 'not_received';
  // CUDE ajeno en la respuesta: sólo es definitivo si esa respuesta es IsValid=false + 99.
  if (isCreditNoteIdentityError(document.lastError) && isDefinitiveDianRejection(document.responseXml)) return 'dian_rejected';
  return null;
}
