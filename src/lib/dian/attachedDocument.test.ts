// El AttachedDocument sólo se puede verificar de verdad contra la DIAN (o
// contra el software del contador del cliente), así que estos tests son la
// única red que tenemos: el snapshot congela el sobre entero y los demás
// casos blindan las tres cosas que lo pueden invalidar sin que se note —
// que los dos documentos de adentro viajen intactos, que el sobre nombre al
// mismo adquiriente que la factura, y que el acuse quede referenciado
// contra el CUFE correcto.
import { describe, expect, it } from "vitest";
import {
  attachedDocumentFileName,
  buildAttachedDocumentXml,
  invoiceIssueInstant,
  type AttachedDocumentInput,
} from "./attachedDocument";
import { CONSUMIDOR_FINAL } from "./emit";
import type { DianParty } from "./ubl";

const emisor: DianParty = {
  name: "SON Y MELONA S.A.S.",
  companyId: "901944469",
  dv: "1",
  idSchemeName: "31",
  taxLevelCode: "O-13",
  taxRegimeCode: "49",
  personType: "1",
  address: {
    cityCode: "05266",
    cityName: "Envigado",
    deptCode: "05",
    deptName: "Antioquia",
    line: "Cra 6 24A Sur 285",
  },
  email: "facturacion@sonymelona.com",
};

const INVOICE_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="no"?>` +
  `<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2">` +
  `<cbc:ID xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">FE1</cbc:ID>` +
  `<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:SignatureValue>Zm9v</ds:SignatureValue></ds:Signature>` +
  `</Invoice>`;

const AR_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="no"?>` +
  `<ApplicationResponse xmlns="urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2">` +
  `<cbc:ID xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">ffffffff</cbc:ID>` +
  `</ApplicationResponse>`;

const CUFE =
  "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

function input(over: Partial<AttachedDocumentInput> = {}): AttachedDocumentInput {
  return {
    environment: "2",
    invoiceNumber: "FE1",
    issueDate: "2026-09-14",
    issueTime: "15:04:05-05:00",
    cufe: CUFE,
    sender: emisor,
    receiver: CONSUMIDOR_FINAL,
    invoiceXml: INVOICE_XML,
    applicationResponseXml: AR_XML,
    ...over,
  };
}

/** Contenido de la n-ésima sección CDATA del sobre. */
function cdataSections(xml: string): string[] {
  return [...xml.matchAll(/<!\[CDATA\[([\s\S]*?)]]>/g)].map((m) => m[1]);
}

describe("buildAttachedDocumentXml — el sobre completo", () => {
  it("queda exactamente como este snapshot", () => {
    expect(buildAttachedDocumentXml(input())).toMatchSnapshot();
  });

  it("se declara como contenedor de factura y apunta al documento padre", () => {
    const xml = buildAttachedDocumentXml(input());
    expect(xml).toContain(
      "<cbc:DocumentType>Contenedor de Factura Electrónica</cbc:DocumentType>",
    );
    expect(xml).toContain("<cbc:ParentDocumentID>FE1</cbc:ParentDocumentID>");
    // El ambiente del sobre tiene que ser el mismo con el que se emitió:
    // un sobre de habilitación presentado como producción es un documento
    // que no existe en el catálogo de la DIAN.
    expect(xml).toContain("<cbc:ProfileExecutionID>2</cbc:ProfileExecutionID>");
    expect(buildAttachedDocumentXml(input({ environment: "1" }))).toContain(
      "<cbc:ProfileExecutionID>1</cbc:ProfileExecutionID>",
    );
  });
});

describe("los dos documentos de adentro", () => {
  it("van en CDATA, en orden, y byte a byte como se firmaron", () => {
    const sections = cdataSections(buildAttachedDocumentXml(input()));
    // Primero la factura, después el acuse: el orden es el del Anexo y es
    // lo que espera cualquier lector que recorra el sobre en secuencia.
    expect(sections).toEqual([INVOICE_XML, AR_XML]);
  });

  it("NO se escapan: escapar el XML firmado rompería su propia firma", () => {
    const xml = buildAttachedDocumentXml(input());
    // Si alguien mete un esc() acá, esto aparece como &lt;ds:Signature&gt;
    // y el contador recibe un archivo que ningún validador acepta.
    expect(xml).toContain("<ds:SignatureValue>Zm9v</ds:SignatureValue>");
    expect(xml).not.toContain("&lt;ds:Signature");
  });

  it("un ']]>' adentro no parte el sobre en dos", () => {
    // Caso patológico: un XML con el cierre de CDATA adentro. Sin el
    // escapado canónico el sobre entero queda corrupto y nadie se entera
    // hasta que el cliente abre el adjunto.
    const raro = `<Invoice><cbc:Note>fin ]]> del mundo</cbc:Note></Invoice>`;
    const xml = buildAttachedDocumentXml(input({ invoiceXml: raro }));
    expect(xml).toContain("]]]]><![CDATA[>");
    // Y al re-leerlo, el contenido vuelve entero.
    const sections = cdataSections(xml);
    expect(sections[0] + sections[1]).toBe(raro);
    expect(sections[2]).toBe(AR_XML);
  });
});

describe("las partes del sobre", () => {
  it("el emisor va con su NIT y el DV en @schemeID", () => {
    const xml = buildAttachedDocumentXml(input());
    const sender = xml.split("<cac:SenderParty>")[1].split("</cac:SenderParty>")[0];
    expect(sender).toContain("<cbc:RegistrationName>SON Y MELONA S.A.S.</cbc:RegistrationName>");
    expect(sender).toContain('schemeID="1"');
    expect(sender).toContain('schemeName="31"');
    expect(sender).toContain(">901944469</cbc:CompanyID>");
  });

  it("el adquiriente es el MISMO que el de la factura, y sin DV", () => {
    const xml = buildAttachedDocumentXml(input());
    const receiver = xml
      .split("<cac:ReceiverParty>")[1]
      .split("</cac:ReceiverParty>")[0];
    expect(receiver).toContain(`>${CONSUMIDOR_FINAL.companyId}</cbc:CompanyID>`);
    // Cédula (schemeName 13) ⇒ el DV no aplica; mandarlo es rechazo.
    expect(receiver).toContain('schemeName="13"');
    expect(receiver).not.toContain("schemeID=");
  });
});

describe("la referencia al acuse de la DIAN", () => {
  it("cuelga del CUFE de la factura y se declara validado", () => {
    const xml = buildAttachedDocumentXml(input());
    const ref = xml
      .split("<cac:ParentDocumentLineReference>")[1]
      .split("</cac:ParentDocumentLineReference>")[0];
    expect(ref).toContain(`<cbc:UUID schemeName="CUFE-SHA384">${CUFE}</cbc:UUID>`);
    expect(ref).toContain("<cbc:DocumentType>ApplicationResponse</cbc:DocumentType>");
    expect(ref).toContain("<cbc:ValidationResultCode>02</cbc:ValidationResultCode>");
  });

  it("por defecto la validación es la de la factura (SendBillSync es síncrono)", () => {
    const xml = buildAttachedDocumentXml(input());
    expect(xml).toContain("<cbc:ValidationDate>2026-09-14</cbc:ValidationDate>");
    expect(xml).toContain("<cbc:ValidationTime>15:04:05-05:00</cbc:ValidationTime>");
  });

  it("cuando la aceptación llega diferida, manda la fecha real de validación", () => {
    // La DIAN valida asíncrono: el acuse puede ser de un día después que la
    // factura, y el sobre tiene que decir cuándo validó de verdad.
    const xml = buildAttachedDocumentXml(
      input({ validationDate: "2026-09-16", validationTime: "08:00:00-05:00" }),
    );
    expect(xml).toContain("<cbc:ValidationDate>2026-09-16</cbc:ValidationDate>");
    expect(xml).toContain("<cbc:ValidationTime>08:00:00-05:00</cbc:ValidationTime>");
    // La fecha de emisión NO se mueve.
    expect(xml).toContain("<cbc:IssueDate>2026-09-14</cbc:IssueDate>");
  });
});

describe("attachedDocumentFileName", () => {
  it("es el número del documento con el prefijo 'ad'", () => {
    expect(attachedDocumentFileName("FESM6482")).toBe("adFESM6482.xml");
  });

  it("no deja pasar nada que rompa el nombre de un archivo", () => {
    // El número sale de datos del comercio; un slash acá escribiría el zip
    // en otro lado o rompería el adjunto del correo.
    expect(attachedDocumentFileName("FE/1 2")).toBe("adFE12.xml");
  });
});

describe("invoiceIssueInstant — la fecha sale del XML, no se re-deriva", () => {
  /** Como lo emite ubl.ts: la resolución primero, la factura después. */
  const factura = (date: string, time: string) =>
    `<Invoice><sts:AuthorizationPeriod><cbc:StartDate>2026-01-01</cbc:StartDate>` +
    `<cbc:EndDate>2027-01-01</cbc:EndDate></sts:AuthorizationPeriod>` +
    `<cbc:IssueDate>${date}</cbc:IssueDate><cbc:IssueTime>${time}</cbc:IssueTime></Invoice>`;

  it("lee la emisión de la factura y no la vigencia de la resolución", () => {
    const got = invoiceIssueInstant(factura("2026-09-14", "21:30:00-05:00"));
    expect(got?.date).toBe("2026-09-14");
    expect(got?.time).toBe("21:30:00-05:00");
  });

  it("el instante respeta el offset de Colombia", () => {
    // 21:30 del 14 en Bogotá son las 02:30 UTC del 15: derivar la fecha de
    // un Date en UTC habría puesto el sobre un día adelante de la factura.
    const got = invoiceIssueInstant(factura("2026-09-14", "21:30:00-05:00"));
    expect(got?.at.toISOString()).toBe("2026-09-15T02:30:00.000Z");
    expect(got?.date).toBe("2026-09-14");
  });

  it("un XML sin fechas o con una fecha basura devuelve null", () => {
    expect(invoiceIssueInstant("<Invoice/>")).toBeNull();
    expect(invoiceIssueInstant(factura("no-es-fecha", "ni-hora"))).toBeNull();
  });
});
