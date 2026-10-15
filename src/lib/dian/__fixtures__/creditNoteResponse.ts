import type { DianResult } from '../soap';

// Synthetic response only; contains no production document or taxpayer data.
export const duplicateCreditNoteRule = 'Regla: 90, Rechazo: Documento procesado anteriormente.';
export function historicalCreditNoteResponse(options: {
  documentNumber?: string; issuerNit?: string; environment?: string; cude?: string;
  transformApplication?: (xml: string) => string;
} = {}): DianResult {
  const cude = options.cude ?? 'c'.repeat(96);
  const application = `<ApplicationResponse xmlns="urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2" xmlns:b="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:a="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2">
    <b:ProfileExecutionID>${options.environment ?? '1'}</b:ProfileExecutionID>
    <b:ID>synthetic-response</b:ID><b:UUID>${'d'.repeat(96)}</b:UUID>
    <b:IssueDate>2025-11-24</b:IssueDate><b:IssueTime>19:17:30-05:00</b:IssueTime>
    <a:SenderParty><a:PartyTaxScheme><b:CompanyID>800197268</b:CompanyID></a:PartyTaxScheme></a:SenderParty>
    <a:ReceiverParty><a:PartyTaxScheme><b:CompanyID>${options.issuerNit ?? '900373076'}</b:CompanyID></a:PartyTaxScheme></a:ReceiverParty>
    <a:DocumentResponse><a:Response><b:ResponseCode>02</b:ResponseCode></a:Response>
      <a:DocumentReference><b:ID>${options.documentNumber ?? 'NC1'}</b:ID><b:UUID>${cude}</b:UUID></a:DocumentReference>
    </a:DocumentResponse>
  </ApplicationResponse>`;
  const encoded = Buffer.from(options.transformApplication?.(application) ?? application).toString('base64');
  const raw = `<Envelope><Body><SendBillSyncResponse><SendBillSyncResult><IsValid>false</IsValid><StatusCode>99</StatusCode><XmlDocumentKey>${cude}</XmlDocumentKey><ErrorMessage><string>${duplicateCreditNoteRule}</string></ErrorMessage><XmlBase64Bytes>${encoded}</XmlBase64Bytes></SendBillSyncResult></SendBillSyncResponse></Body></Envelope>`;
  return { state: 'rejected', statusCode: '99', cufe: cude, errors: [duplicateCreditNoteRule], raw };
}
