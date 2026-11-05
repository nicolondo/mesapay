// Los mensajes de la DIAN se guardaban con «�» donde iba una tilde o una
// «ñ» («Se�or usuario…»): `Response.text()` decodifica siempre como UTF-8
// y la DIAN a veces responde en Latin-1. Y GetXmlByDocumentKey: cómo se
// saca el XML firmado de su respuesta.
import { afterEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { decodeSoapBody, documentXmlFromResponse, fetchTransport, parseDianResponse } from "./soap";

const MSG = "Regla: RUT01, Rechazo: Señor usuario, facturar electrónicamente";
const envelope = (msg: string, decl = "") =>
  `${decl}<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><R><ErrorMessage><string>${msg}</string></ErrorMessage><IsValid>false</IsValid><StatusCode>99</StatusCode></R></s:Body></s:Envelope>`;

describe("decodeSoapBody", () => {
  it("UTF-8 válido queda igual", () => {
    expect(decodeSoapBody(Buffer.from(envelope(MSG), "utf8"))).toContain("Señor usuario");
  });

  it("Latin-1 sin declarar (o declarado como UTF-8 por error) se lee como windows-1252", () => {
    const bytes = Buffer.from(envelope(MSG), "latin1");
    expect(decodeSoapBody(bytes)).toContain("Señor usuario, facturar electrónicamente");
    expect(decodeSoapBody(bytes, "application/soap+xml; charset=utf-8")).toContain("Señor usuario");
    expect(decodeSoapBody(bytes)).not.toContain("�");
  });

  it("respeta el charset declarado en el Content-Type o en la declaración XML", () => {
    const bytes = Buffer.from(envelope(MSG), "latin1");
    expect(decodeSoapBody(bytes, "text/xml; charset=ISO-8859-1")).toContain("Señor");
    const declared = Buffer.from(envelope(MSG, '<?xml version="1.0" encoding="iso-8859-1"?>'), "latin1");
    expect(decodeSoapBody(declared)).toContain("Señor");
  });

  it("el mensaje parseado sale con sus tildes", () => {
    const parsed = parseDianResponse(decodeSoapBody(Buffer.from(envelope(MSG), "latin1")));
    expect(parsed.errors).toEqual([MSG]);
  });
});

describe("fetchTransport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lee los BYTES y los decodifica con el charset correcto", async () => {
    const body = Buffer.from(envelope(MSG), "latin1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "application/soap+xml" } })),
    );
    const res = await fetchTransport("https://example.test", "action", "<x/>");
    expect(res.body).toContain("Señor usuario, facturar electrónicamente");
  });
});

describe("documentXmlFromResponse (GetXmlByDocumentKey)", () => {
  const invoice = `<?xml version="1.0" encoding="UTF-8"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"><cbc:ID xmlns:cbc="x">FESM1</cbc:ID></Invoice>`;
  const wrap = (b64: string) =>
    `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><GetXmlByDocumentKeyResponse><GetXmlByDocumentKeyResult><b:Code xmlns:b="b">100</b:Code><b:XmlBytesBase64 xmlns:b="b">${b64}</b:XmlBytesBase64></GetXmlByDocumentKeyResult></GetXmlByDocumentKeyResponse></s:Body></s:Envelope>`;

  it("saca la factura en base64", async () => {
    expect(await documentXmlFromResponse(wrap(Buffer.from(invoice).toString("base64")))).toBe(invoice);
  });

  it("y también si viene zipeada", async () => {
    const zip = new JSZip();
    zip.file("fv.xml", invoice);
    const b64 = (await zip.generateAsync({ type: "nodebuffer" })).toString("base64");
    expect(await documentXmlFromResponse(wrap(b64))).toBe(invoice);
  });

  it("un acuse u otra cosa que no sea una factura ⇒ null (nunca se guarda en su lugar)", async () => {
    const ar = `<ApplicationResponse xmlns="urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2"/>`;
    expect(await documentXmlFromResponse(wrap(Buffer.from(ar).toString("base64")))).toBeNull();
    expect(await documentXmlFromResponse("<s:Envelope><s:Body><Fault/></s:Body></s:Envelope>")).toBeNull();
    expect(await documentXmlFromResponse(null)).toBeNull();
  });
});
