// Builder UBL 2.1 del AttachedDocument — el "contenedor" que el emisor le
// entrega al ADQUIRIENTE cuando la DIAN acepta la factura.
//
// Ojo con no confundirlo con lo que se le manda a la DIAN (ubl.ts): eso es
// la factura sola, firmada. Lo que el artículo 30 de la Res. 000042/2020
// obliga a entregarle al comprador es este sobre, que envuelve DOS
// documentos completos en CDATA:
//
//   1. el XML FIRMADO de la factura, tal cual se envió, y
//   2. el ApplicationResponse de la DIAN — el acuse que dice que la aceptó.
//
// Sin el (2) el adjunto no prueba nada: cualquiera puede fabricar un XML
// de factura. Los dos insumos ya están guardados en DianDocument (`xmlZip`
// y `responseXml`), así que este módulo es una función PURA: recibe los
// dos XML resueltos y arma el sobre. Mismo criterio de escapado y mismos
// helpers que ubl.ts, y la estructura sale del Anexo Técnico 1.9 (público)
// que ya citan ubl.ts y soap.ts.
import type { DianParty } from "@/lib/dian/ubl";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Mismo `esc` que ubl.ts: sólo lo que rompe un atributo o un tag. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Envuelve un XML COMPLETO en CDATA. Acá NO se escapa nada: el punto del
 * CDATA es que los dos documentos viajen byte a byte como los firmó su
 * emisor — escaparlos rompería la firma de quien intente validarla.
 *
 * Lo único que hay que tratar es el propio cierre `]]>` si apareciera
 * dentro del contenido: se parte en dos secciones CDATA pegadas, que es
 * la forma canónica de escaparlo en XML. Un XML firmado no debería
 * traerlo nunca, pero si lo trajera el sobre entero quedaría corrupto y
 * nadie se enteraría hasta que el cliente abriera el adjunto.
 */
function cdata(xml: string): string {
  return `<![CDATA[${xml.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}

/** Atributos de identificación DIAN, idénticos a los que usa ubl.ts. */
const AGENCY =
  'schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)"';

/**
 * Bloque de una de las dos partes del sobre. El AttachedDocument NO lleva
 * el grupo completo de la factura (ni dirección, ni PartyLegalEntity):
 * el Anexo sólo pide identificar quién manda y quién recibe, y el detalle
 * fiscal ya va adentro, en el XML de la factura.
 *
 * El DV va en @schemeID y SÓLO cuando el documento es NIT (schemeName 31)
 * — mismo criterio que partyXml de ubl.ts, donde mandarlo en una cédula
 * provocaba rechazo.
 */
function partyXml(tag: "SenderParty" | "ReceiverParty", p: DianParty): string {
  const dvAttr =
    p.dv != null && p.idSchemeName === "31" ? ` schemeID="${esc(p.dv)}"` : "";
  return (
    `<cac:${tag}>` +
    `<cac:PartyTaxScheme>` +
    `<cbc:RegistrationName>${esc(p.name)}</cbc:RegistrationName>` +
    `<cbc:CompanyID${dvAttr} schemeName="${p.idSchemeName}" ${AGENCY}>${esc(p.companyId)}</cbc:CompanyID>` +
    `<cbc:TaxLevelCode>${esc(p.taxLevelCode)}</cbc:TaxLevelCode>` +
    `<cac:TaxScheme>` +
    `<cbc:ID>${p.taxRegimeCode === "48" ? "01" : "ZZ"}</cbc:ID>` +
    `<cbc:Name>${p.taxRegimeCode === "48" ? "IVA" : "No aplica"}</cbc:Name>` +
    `</cac:TaxScheme>` +
    `</cac:PartyTaxScheme>` +
    `</cac:${tag}>`
  );
}

/** cac:Attachment con un documento entero adentro, en CDATA. */
function attachmentXml(xml: string): string {
  return (
    `<cac:Attachment>` +
    `<cac:ExternalReference>` +
    `<cbc:MimeCode>text/xml</cbc:MimeCode>` +
    `<cbc:EncodingCode>UTF-8</cbc:EncodingCode>` +
    `<cbc:Description>${cdata(xml)}</cbc:Description>` +
    `</cac:ExternalReference>` +
    `</cac:Attachment>`
  );
}

// ── Entrada ─────────────────────────────────────────────────────────────────

export type AttachedDocumentInput = {
  /** "1" producción · "2" habilitación — el mismo del XML de la factura. */
  environment: "1" | "2";
  /** Número COMPLETO del documento contenido (prefijo + consecutivo). */
  invoiceNumber: string;
  /** "YYYY-MM-DD" y "HH:mm:ss-05:00" (hora Colombia) de la factura. */
  issueDate: string;
  issueTime: string;
  /** CUFE de la factura contenida. */
  cufe: string;
  /** Emisor (el comercio) y adquiriente — los MISMOS de la factura. */
  sender: DianParty;
  receiver: DianParty;
  /** XML FIRMADO de la factura, tal cual se envió a la DIAN. */
  invoiceXml: string;
  /** ApplicationResponse de la DIAN: el acuse de la aceptación. */
  applicationResponseXml: string;
  /**
   * Fecha/hora en que la DIAN validó. Por defecto las de la factura: en
   * SendBillSync la validación es síncrona, así que coinciden. Cuando la
   * aceptación llega por la consulta diferida el caller pasa las reales.
   */
  validationDate?: string;
  validationTime?: string;
};

/**
 * Arma el AttachedDocument. Devuelve el XML listo para zipear y adjuntar
 * al correo del adquiriente.
 *
 * Este sobre NO se firma ni se le manda a la DIAN: es entrega al cliente.
 * Por eso no lleva ext:UBLExtensions ni CUFE propio — el que vale es el de
 * la factura de adentro, que sí viaja firmada.
 */
export function buildAttachedDocumentXml(i: AttachedDocumentInput): string {
  const validationDate = i.validationDate ?? i.issueDate;
  const validationTime = i.validationTime ?? i.issueTime;

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="no"?>` +
    `<AttachedDocument xmlns="urn:oasis:names:specification:ubl:schema:xsd:AttachedDocument-2" ` +
    `xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" ` +
    `xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" ` +
    `xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2" ` +
    `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<cbc:UBLVersionID>UBL 2.1</cbc:UBLVersionID>` +
    // "humano" es el literal que el Anexo Técnico le asigna al contenedor
    // legible por personas (que es lo que es esto), no un código de
    // operación como el "10" de la factura.
    `<cbc:CustomizationID>humano</cbc:CustomizationID>` +
    `<cbc:ProfileID>DIAN 2.1</cbc:ProfileID>` +
    `<cbc:ProfileExecutionID>${i.environment}</cbc:ProfileExecutionID>` +
    // El sobre se identifica con el MISMO número de la factura que lleva
    // adentro: para el adquiriente son el mismo documento.
    `<cbc:ID>${esc(i.invoiceNumber)}</cbc:ID>` +
    `<cbc:IssueDate>${i.issueDate}</cbc:IssueDate>` +
    `<cbc:IssueTime>${i.issueTime}</cbc:IssueTime>` +
    `<cbc:DocumentType>Contenedor de Factura Electrónica</cbc:DocumentType>` +
    `<cbc:ParentDocumentID>${esc(i.invoiceNumber)}</cbc:ParentDocumentID>` +
    partyXml("SenderParty", i.sender) +
    partyXml("ReceiverParty", i.receiver) +
    // (1) La factura firmada.
    attachmentXml(i.invoiceXml) +
    // (2) El acuse de la DIAN, referenciado contra la factura (CUFE) y con
    // el resultado de la validación. ValidationResultCode "02" = documento
    // validado por la DIAN; ValidatorID es el literal que usa la entidad.
    `<cac:ParentDocumentLineReference>` +
    `<cbc:LineID>1</cbc:LineID>` +
    `<cac:DocumentReference>` +
    `<cbc:ID>${esc(i.invoiceNumber)}</cbc:ID>` +
    `<cbc:UUID schemeName="CUFE-SHA384">${esc(i.cufe)}</cbc:UUID>` +
    `<cbc:IssueDate>${i.issueDate}</cbc:IssueDate>` +
    `<cbc:DocumentType>ApplicationResponse</cbc:DocumentType>` +
    attachmentXml(i.applicationResponseXml) +
    `<cac:ResultOfVerification>` +
    `<cbc:ValidatorID>Unidad Especial Dirección de Impuestos y Aduanas Nacionales</cbc:ValidatorID>` +
    `<cbc:ValidationResultCode>02</cbc:ValidationResultCode>` +
    `<cbc:ValidationDate>${validationDate}</cbc:ValidationDate>` +
    `<cbc:ValidationTime>${validationTime}</cbc:ValidationTime>` +
    `</cac:ResultOfVerification>` +
    `</cac:DocumentReference>` +
    `</cac:ParentDocumentLineReference>` +
    `</AttachedDocument>`
  );
}

export type InvoiceIssueInstant = {
  /** "YYYY-MM-DD" tal cual lo declara la factura. */
  date: string;
  /** "HH:mm:ss-05:00" tal cual lo declara la factura. */
  time: string;
  /** Los dos anteriores como instante, para formatear en el correo. */
  at: Date;
};

/**
 * Lee la fecha/hora de emisión DEL PROPIO XML firmado.
 *
 * Parece rebuscado teniendo `Order.paidAt` a mano, pero no lo es: el sobre
 * y la factura que lleva adentro tienen que declarar la MISMA fecha, y esas
 * dos no siempre coinciden con el cobro. El `issueDate` de la factura se
 * fija en el momento del envío a la DIAN —que puede ser horas después de
 * que se cerró la cuenta, o de un reintento al día siguiente— y además se
 * calcula en UTC, así que un cobro de las 9 p. m. en Bogotá ya cayó al día
 * siguiente. Derivarla otra vez acá es garantizar que tarde o temprano no
 * cuadren. Se lee la primera ocurrencia: en la factura las de la resolución
 * son StartDate/EndDate, y las líneas no llevan fecha.
 *
 * null si el XML no las trae (el caller cae a la fecha del cobro).
 */
export function invoiceIssueInstant(
  invoiceXml: string,
): InvoiceIssueInstant | null {
  const date = invoiceXml.match(/<cbc:IssueDate>([^<]+)<\/cbc:IssueDate>/)?.[1]?.trim();
  const time = invoiceXml.match(/<cbc:IssueTime>([^<]+)<\/cbc:IssueTime>/)?.[1]?.trim();
  if (!date || !time) return null;
  const at = new Date(`${date}T${time}`);
  if (Number.isNaN(at.getTime())) return null;
  return { date, time, at };
}

/**
 * Nombre del archivo del sobre. La convención de la DIAN para el
 * AttachedDocument es el prefijo "ad" + el número del documento; el mismo
 * nombre se usa adentro del zip y como adjunto del correo, para que el
 * cliente vea siempre el mismo nombre que su contador le va a pedir.
 */
export function attachedDocumentFileName(invoiceNumber: string): string {
  return `ad${invoiceNumber.replace(/[^A-Za-z0-9_-]/g, "")}.xml`;
}
