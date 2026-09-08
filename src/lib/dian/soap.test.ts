// parseDianResponse contra respuestas REALES de vpfe-hab (capturadas el
// 2026-09-08 con el certificado del comercio). El punto de estas pruebas
// es que los tres casos NO se confundan entre sí: "en proceso" tiene que
// seguir siendo pending —el documento va en curso y se vuelve a
// consultar—, el rechazo por reglas tiene que ser rejected, y sólo una
// respuesta que de verdad no se entiende puede ser error.
import { describe, expect, it } from "vitest";
import { parseDianResponse } from "./soap";
import { transitionAfterPoll, transitionAfterSend } from "./documentState";

/**
 * GetStatusZip consultado inmediatamente después de enviar: la DIAN aún
 * está validando el lote. StatusCode viene VACÍO y no hay reglas — el
 * único indicio es el texto de StatusDescription.
 */
const EN_PROCESO = `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://www.w3.org/2005/08/addressing" xmlns:u="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"><s:Header><a:Action s:mustUnderstand="1">http://wcf.dian.colombia/IWcfDianCustomerServices/GetStatusZipResponse</a:Action><a:RelatesTo>urn:uuid:e8779552-cc06-4a75-b23d-342b8599b94d</a:RelatesTo></s:Header><s:Body><GetStatusZipResponse xmlns="http://wcf.dian.colombia"><GetStatusZipResult xmlns:b="http://schemas.datacontract.org/2004/07/DianResponse" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><b:DianResponse><b:ErrorMessage i:nil="true" xmlns:c="http://schemas.microsoft.com/2003/10/Serialization/Arrays"/><b:IsValid>false</b:IsValid><b:StatusCode/><b:StatusDescription>Batch en proceso de validación.</b:StatusDescription><b:StatusMessage i:nil="true"/><b:XmlBase64Bytes i:nil="true"/><b:XmlBytes i:nil="true"/><b:XmlDocumentKey i:nil="true"/><b:XmlFileName i:nil="true"/></b:DianResponse></GetStatusZipResult></GetStatusZipResponse></s:Body></s:Envelope>`;

/**
 * GetStatusZip del mismo documento unos segundos después: la DIAN ya
 * validó y devuelve las reglas incumplidas (XmlBase64Bytes recortado, en
 * el original trae el ApplicationResponse completo).
 */
const RECHAZADO = `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://www.w3.org/2005/08/addressing"><s:Header><a:Action s:mustUnderstand="1">http://wcf.dian.colombia/IWcfDianCustomerServices/GetStatusZipResponse</a:Action></s:Header><s:Body><GetStatusZipResponse xmlns="http://wcf.dian.colombia"><GetStatusZipResult xmlns:b="http://schemas.datacontract.org/2004/07/DianResponse" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><b:DianResponse><b:ErrorMessage xmlns:c="http://schemas.microsoft.com/2003/10/Serialization/Arrays"><c:string>Regla: FAB10a, Rechazo: El prefijo de numeración no es igual al código de la sucursal correspondiente a este punto de facturación</c:string><c:string>Regla: FAJ50, Notificación: El prefijo debe corresponder  al código de la sucursal de este punto de facturación</c:string></b:ErrorMessage><b:IsValid>false</b:IsValid><b:StatusCode>99</b:StatusCode><b:StatusDescription>Validación contiene errores en campos mandatorios.</b:StatusDescription><b:StatusMessage>Documento con errores en campos mandatorios.</b:StatusMessage><b:XmlBase64Bytes>UExBQ0VIT0xERVI=</b:XmlBase64Bytes><b:XmlBytes i:nil="true"/><b:XmlDocumentKey>2bbe2352785f97e65af9c71141ca241a75d416d9208a7bf832bfb086d40edfc62dcd435e006fe2d0a40995198199422c</b:XmlDocumentKey><b:XmlFileName>SETP990000001</b:XmlFileName></b:DianResponse></GetStatusZipResult></GetStatusZipResponse></s:Body></s:Envelope>`;

/**
 * SOAP Fault real: la DIAN rechaza el MENSAJE (firma WS-Security
 * inválida) y nunca llega a mirar el documento. Es el caso que motivó
 * quitar el `pending` por defecto — se mostraba "en proceso" un envío que
 * jamás entró.
 */
const FAULT = `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://www.w3.org/2005/08/addressing"><s:Header><a:Action s:mustUnderstand="1">http://www.w3.org/2005/08/addressing/soap/fault</a:Action></s:Header><s:Body><s:Fault><s:Code><s:Value>s:Sender</s:Value><s:Subcode><s:Value xmlns:a="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">a:InvalidSecurity</s:Value></s:Subcode></s:Code><s:Reason><s:Text xml:lang="en-US">An error occurred when verifying security for the message.</s:Text></s:Reason></s:Fault></s:Body></s:Envelope>`;

/** SendTestSetAsync aceptado: la DIAN devuelve el ZipKey a consultar. */
const ENVIO_ACEPTADO = `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://www.w3.org/2005/08/addressing"><s:Header><a:Action s:mustUnderstand="1">http://wcf.dian.colombia/IWcfDianCustomerServices/SendTestSetAsyncResponse</a:Action></s:Header><s:Body><SendTestSetAsyncResponse xmlns="http://wcf.dian.colombia"><SendTestSetAsyncResult xmlns:b="http://schemas.datacontract.org/2004/07/UploadDocumentResponse" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><b:ErrorMessageList i:nil="true" xmlns:c="http://schemas.datacontract.org/2004/07/XmlParamsResponseTrackId"/><b:ZipKey>79351fbb-b8cd-4504-bf19-09a7f6f2d3d7</b:ZipKey></SendTestSetAsyncResult></SendTestSetAsyncResponse></s:Body></s:Envelope>`;

describe("parseDianResponse — el lote sigue en validación", () => {
  it("«Batch en proceso de validación.» es pending, no error", () => {
    const r = parseDianResponse(EN_PROCESO);
    expect(r.state).toBe("pending");
    expect(r.statusMessage).toBe("Batch en proceso de validación.");
    expect(r.errors).toEqual([]);
  });

  it("el documento se puede volver a consultar y conserva su trackId", () => {
    const t = transitionAfterPoll(parseDianResponse(EN_PROCESO), {
      cufe: "cufe-1",
      trackId: "2ee45a08-d944-4722-b2c7-eb9307c519bd",
    });
    expect(t.state).toBe("pending");
    expect(t.poll).toBe(true);
    expect(t.trackId).toBe("2ee45a08-d944-4722-b2c7-eb9307c519bd");
    expect(t.errors).toEqual([]);
  });
});

describe("parseDianResponse — la DIAN rechazó por reglas", () => {
  it("devuelve rejected con las reglas tal cual", () => {
    const r = parseDianResponse(RECHAZADO);
    expect(r.state).toBe("rejected");
    expect(r.statusCode).toBe("99");
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0]).toContain("Regla: FAB10a");
    expect(r.errors[1]).toContain("Regla: FAJ50");
  });

  it("el documento queda rechazado y no se vuelve a consultar", () => {
    const t = transitionAfterSend(parseDianResponse(RECHAZADO), "cufe-1");
    expect(t.state).toBe("rejected");
    expect(t.poll).toBe(false);
    expect(t.fiscal).toBe(false);
  });
});

describe("parseDianResponse — el mensaje no llegó a la DIAN", () => {
  it("un SOAP Fault es error, nunca pending", () => {
    const r = parseDianResponse(FAULT);
    expect(r.state).toBe("error");
    expect(r.statusCode).toContain("InvalidSecurity");
    expect(r.errors[0]).toContain("InvalidSecurity");
  });

  it("una respuesta ilegible es error", () => {
    const r = parseDianResponse(
      `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><Cualquiera/></s:Body></s:Envelope>`,
    );
    expect(r.state).toBe("error");
    expect(r.errors).toEqual(["respuesta no reconocida de la DIAN"]);
  });
});

describe("parseDianResponse — envío asíncrono aceptado", () => {
  it("el ZipKey deja el documento pendiente de consulta", () => {
    const r = parseDianResponse(ENVIO_ACEPTADO);
    expect(r.state).toBe("pending");
    expect(r.zipKey).toBe("79351fbb-b8cd-4504-bf19-09a7f6f2d3d7");
    expect(transitionAfterSend(r, "cufe-1").trackId).toBe(
      "79351fbb-b8cd-4504-bf19-09a7f6f2d3d7",
    );
  });
});
