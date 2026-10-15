import { describe, expect, it } from 'vitest';
import { diagnoseCreditNoteResponse, storedCreditNoteIdentityFailure } from './creditNoteResponse';
import { duplicateCreditNoteRule, historicalCreditNoteResponse } from './__fixtures__/creditNoteResponse';
const identity = { documentNumber: 'NC1', issuerNit: '900373076', environment: '1', cude: 'b'.repeat(96) };

describe('credit-note response identity', () => {
  it('recognizes a historical duplicate for the same issuer, environment and document number without accepting it', async () => {
    const result = historicalCreditNoteResponse();
    expect(await diagnoseCreditNoteResponse(result, identity)).toEqual({ ...result, state: 'error', errors: ['dian_numbering_conflict', duplicateCreditNoteRule] });
    expect(result.errors).toEqual([duplicateCreditNoteRule]);
  });
  it.each([
    { issuerNit: '900000000' }, { environment: '2' }, { documentNumber: 'NC99' },
    { transformApplication: (xml: string) => xml.replace('800197268', '900000000') },
    { transformApplication: (xml: string) => xml.replace('<b:ResponseCode>02</b:ResponseCode>', '<b:ResponseCode>04</b:ResponseCode>') },
    { transformApplication: (xml: string) => xml.replace('</a:DocumentReference>', '<b:UUID>extra</b:UUID></a:DocumentReference>') },
    { transformApplication: (xml: string) => xml.replace('<b:ID>NC1</b:ID>', '') },
    { transformApplication: (xml: string) => xml.replace('CommonAggregateComponents-2', 'wrong-namespace') },
    { transformApplication: (xml: string) => xml.replace('c'.repeat(96), 'e'.repeat(96)) },
    { transformApplication: (xml: string) => '<!DOCTYPE ApplicationResponse [<!ENTITY x "fake">]>' + xml },
    { transformApplication: () => '<ApplicationResponse>malformed' },
  ])('keeps unrelated or ambiguous responses blocked: %j', async options => {
    const result = await diagnoseCreditNoteResponse(historicalCreditNoteResponse(options), identity);
    expect(result.state).toBe('error');
    expect(result.errors).toEqual(['response_identifier_mismatch', duplicateCreditNoteRule]);
  });
  it('requires both status99 and the duplicate rule, plus the embedded response', async () => {
    const response = historicalCreditNoteResponse();
    for (const change of [{ statusCode: '90' }, { errors: ['Other rule'] }, { raw: undefined }, { state: 'accepted' as const }]) {
      expect((await diagnoseCreditNoteResponse({ ...response, ...change }, identity)).errors[0]).toBe('response_identifier_mismatch');
    }
  });
  it('never confuses the ApplicationResponse root UUID with the referenced CUDE', async () => {
    const result = historicalCreditNoteResponse({ transformApplication: xml => xml.replace('d'.repeat(96), identity.cude) });
    expect((await diagnoseCreditNoteResponse(result, identity)).errors[0]).toBe('dian_numbering_conflict');
  });
  it('leaves the same-CUDE duplicate and ordinary matching acceptance to existing state handling', async () => {
    const response = historicalCreditNoteResponse({ cude: identity.cude });
    expect(await diagnoseCreditNoteResponse(response, identity)).toBe(response);
    const accepted = { state: 'accepted' as const, cufe: ` ${identity.cude.toUpperCase()} `, errors: [] };
    expect(await diagnoseCreditNoteResponse(accepted, identity)).toBe(accepted);
    const missing = { state: 'pending' as const, errors: [] };
    expect(await diagnoseCreditNoteResponse(missing, identity)).toBe(missing);
  });
  it('recovers a legacy mismatch diagnosis from the stored DIAN response without any resend', async () => {
    const stored = { lastError: 'response_identifier_mismatch', errors: ['response_identifier_mismatch'], responseXml: historicalCreditNoteResponse().raw! };
    expect(await storedCreditNoteIdentityFailure(stored, identity)).toMatchObject({ errors: ['dian_numbering_conflict', duplicateCreditNoteRule], raw: stored.responseXml });
  });
  it('retains a known conflict even when stored response is unavailable or malformed', async () => {
    for (const responseXml of [null, '<malformed']) {
      expect(await storedCreditNoteIdentityFailure({ lastError: 'dian_numbering_conflict', errors: ['dian_numbering_conflict', duplicateCreditNoteRule], responseXml }, identity)).toMatchObject({ state: 'error', errors: ['dian_numbering_conflict', duplicateCreditNoteRule] });
    }
    expect(await storedCreditNoteIdentityFailure({ lastError: null, errors: null, responseXml: null }, identity)).toBeNull();
  });
});
