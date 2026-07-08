// Cliente SOAP de los web services de la DIAN (ERP B1.4) — canal WCF con
// WS-Security. Implementado desde el Anexo Técnico 1.9 + la doc pública
// de los servicios (SendBillSync, SendTestSetAsync, GetStatus,
// GetStatusZip). El envelope se firma con el mismo certificado del
// comercio (BinarySecurityToken + firma del Timestamp), igual criterio
// de canonicalización que la firma XAdES (B1.2).
import { createHash, randomUUID } from "crypto";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { ExclusiveCanonicalization } from "xml-crypto";
import forge from "node-forge";
import JSZip from "jszip";
import type { LoadedCert } from "@/lib/dian/crypto";

const DS = "http://www.w3.org/2000/09/xmldsig#";
const WSU =
  "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd";
const WSSE =
  "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd";

export const DIAN_ENDPOINTS = {
  habilitacion: "https://vpfe-hab.dian.gov.co/WcfDianCustomerServices.svc",
  produccion: "https://vpfe.dian.gov.co/WcfDianCustomerServices.svc",
} as const;

const ACTION_BASE = "http://wcf.dian.colombia/IWcfDianCustomerServices";

// ── ZIP del documento (la DIAN recibe el XML zippeado en base64) ────────────

export async function zipInvoice(fileName: string, xml: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(fileName, xml);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

// ── Firma WS-Security del envelope ──────────────────────────────────────────

type XmlNode = NonNullable<ReturnType<DOMParser["parseFromString"]>["documentElement"]>;

function sha256b64(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("base64");
}

function ancestorNamespaces(node: XmlNode): Array<{ prefix: string; namespaceURI: string }> {
  const seen = new Set<string>();
  const out: Array<{ prefix: string; namespaceURI: string }> = [];
  let cur = node.parentNode as XmlNode | null;
  while (cur && cur.nodeType === 1) {
    const attrs = cur.attributes;
    for (let i = 0; i < attrs.length; i++) {
      const a = attrs.item(i)!;
      let prefix: string | null = null;
      if (a.nodeName === "xmlns") prefix = "";
      else if (a.nodeName.startsWith("xmlns:")) prefix = a.nodeName.slice(6);
      if (prefix === null || seen.has(prefix)) continue;
      seen.add(prefix);
      out.push({ prefix, namespaceURI: a.nodeValue ?? "" });
    }
    cur = cur.parentNode as XmlNode | null;
  }
  return out;
}

function nowPlus(seconds: number): string {
  const d = new Date(Date.now() + seconds * 1000);
  return d.toISOString().replace(/\.\d{3}Z$/, ".000Z");
}

/**
 * Construye el envelope SOAP firmado para un servicio. `bodyInner` es el
 * XML del cuerpo de la operación (sin el wrapper de acción). Firma el
 * wsu:Timestamp (referenciado por Id) con el certificado del comercio.
 */
export function buildSignedSoapEnvelope(
  service: string,
  bodyInner: string,
  cert: LoadedCert,
  now: () => string = () => nowPlus(0),
): string {
  const tokenId = "X509-" + randomUUID();
  const tsId = "TS-" + randomUUID();
  const sigId = "SIG-" + randomUUID();
  const created = now();
  const expires = nowPlus(60000);

  const template =
    `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" ` +
    `xmlns:wcf="http://wcf.dian.colombia">` +
    `<soap:Header xmlns:wsa="http://www.w3.org/2005/08/addressing">` +
    `<wsse:Security xmlns:wsse="${WSSE}" xmlns:wsu="${WSU}" soap:mustUnderstand="true">` +
    `<wsse:BinarySecurityToken EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary" ` +
    `ValueType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3" ` +
    `wsu:Id="${tokenId}">${cert.certDerBase64}</wsse:BinarySecurityToken>` +
    `<ds:Signature xmlns:ds="${DS}" Id="${sigId}">` +
    `<ds:SignedInfo>` +
    `<ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></ds:CanonicalizationMethod>` +
    `<ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"></ds:SignatureMethod>` +
    `<ds:Reference URI="#${tsId}">` +
    `<ds:Transforms><ds:Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></ds:Transform></ds:Transforms>` +
    `<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod>` +
    `<ds:DigestValue></ds:DigestValue>` +
    `</ds:Reference>` +
    `</ds:SignedInfo>` +
    `<ds:SignatureValue></ds:SignatureValue>` +
    `<ds:KeyInfo>` +
    `<wsse:SecurityTokenReference xmlns:wsse="${WSSE}">` +
    `<wsse:Reference URI="#${tokenId}" ValueType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3"></wsse:Reference>` +
    `</wsse:SecurityTokenReference>` +
    `</ds:KeyInfo>` +
    `</ds:Signature>` +
    `<wsu:Timestamp xmlns:wsu="${WSU}" wsu:Id="${tsId}">` +
    `<wsu:Created>${created}</wsu:Created>` +
    `<wsu:Expires>${expires}</wsu:Expires>` +
    `</wsu:Timestamp>` +
    `</wsse:Security>` +
    `<wsa:Action>${ACTION_BASE}/${service}</wsa:Action>` +
    `<wsa:To xmlns:wsu="${WSU}" wsu:Id="To-${randomUUID()}">HTTPS://VPFE.DIAN.GOV.CO/WCFDIANCUSTOMERSERVICES.SVC</wsa:To>` +
    `</soap:Header>` +
    `<soap:Body><wcf:${service}>${bodyInner}</wcf:${service}></soap:Body>` +
    `</soap:Envelope>`;

  const doc = new DOMParser().parseFromString(template, "text/xml");
  const findId = (id: string): XmlNode | null => {
    const walk = (n: XmlNode): XmlNode | null => {
      if (n.nodeType === 1) {
        const el = n as unknown as Element;
        if (
          el.getAttributeNS?.(WSU, "Id") === id ||
          el.getAttribute?.("Id") === id
        )
          return n;
      }
      for (let i = 0; i < n.childNodes.length; i++) {
        const r = walk(n.childNodes.item(i) as unknown as XmlNode);
        if (r) return r;
      }
      return null;
    };
    return walk(doc.documentElement as unknown as XmlNode);
  };

  const timestamp = findId(tsId)!;
  const sig = findId(sigId)! as unknown as Element;
  const signedInfo = sig.getElementsByTagNameNS(DS, "SignedInfo").item(0)! as unknown as XmlNode;
  const digestValue = sig.getElementsByTagNameNS(DS, "DigestValue").item(0)!;
  const signatureValue = sig.getElementsByTagNameNS(DS, "SignatureValue").item(0)!;

  // Digest del Timestamp (exc-c14n con ns heredados).
  digestValue.appendChild(doc.createTextNode(sha256b64(excC14n(timestamp))) as never);
  // Firmar el SignedInfo.
  const md = forge.md.sha256.create();
  md.update(excC14n(signedInfo), "utf8");
  const key = forge.pki.privateKeyFromPem(cert.keyPem);
  signatureValue.appendChild(doc.createTextNode(forge.util.encode64(key.sign(md))) as never);

  return new XMLSerializer().serializeToString(doc as never);
}

/** Exclusive C14N (xml-exc-c14n#) — la que usan los Algorithm del SOAP. */
function excC14n(node: XmlNode): string {
  return new ExclusiveCanonicalization().process(node as never, {
    ancestorNamespaces: ancestorNamespaces(node),
  }) as string;
}

// ── Cuerpos de las operaciones ──────────────────────────────────────────────

export function sendBillSyncBody(fileName: string, zipB64: string): string {
  return `<wcf:fileName>${fileName}</wcf:fileName><wcf:contentFile>${zipB64}</wcf:contentFile>`;
}
export function sendTestSetAsyncBody(
  fileName: string,
  zipB64: string,
  testSetId: string,
): string {
  return `<wcf:fileName>${fileName}</wcf:fileName><wcf:contentFile>${zipB64}</wcf:contentFile><wcf:testSetId>${testSetId}</wcf:testSetId>`;
}
export function getStatusBody(trackId: string): string {
  return `<wcf:trackId>${trackId}</wcf:trackId>`;
}
export function getStatusZipBody(trackId: string): string {
  return `<wcf:trackId>${trackId}</wcf:trackId>`;
}

// ── Parseo de respuestas ────────────────────────────────────────────────────

export type DianResult = {
  state: "accepted" | "rejected" | "pending" | "error";
  statusCode?: string | null;
  statusMessage?: string | null;
  cufe?: string | null;
  zipKey?: string | null;
  errors: string[];
};

function textAll(root: XmlNode, local: string): string[] {
  const out: string[] = [];
  const el = root as unknown as Element;
  // Búsqueda por localName ignorando namespace (la DIAN varía prefijos).
  const walk = (n: Element) => {
    if (n.localName === local && n.textContent) out.push(n.textContent);
    for (let i = 0; i < n.childNodes.length; i++) {
      const c = n.childNodes.item(i);
      if (c && (c as Element).nodeType === 1) walk(c as Element);
    }
  };
  walk(el);
  return out;
}
function text1(root: XmlNode, local: string): string | null {
  return textAll(root, local)[0] ?? null;
}

/**
 * Interpreta la respuesta de SendBillSync/GetStatus. IsValid=true ⇒
 * aceptado; con StatusCode y errores ⇒ rechazado; sin StatusCode ⇒
 * pendiente (asíncrono). Errores en ErrorMessage/string.
 */
export function parseDianResponse(responseXml: string): DianResult {
  let root: XmlNode;
  try {
    root = new DOMParser().parseFromString(responseXml, "text/xml")
      .documentElement as unknown as XmlNode;
  } catch {
    return { state: "error", errors: ["respuesta ilegible de la DIAN"] };
  }
  const isValid = text1(root, "IsValid") === "true";
  const statusCode = text1(root, "StatusCode");
  const statusMessage = text1(root, "StatusDescription") ?? text1(root, "StatusMessage");
  const cufe = text1(root, "XmlDocumentKey");
  const zipKey = text1(root, "ZipKey");
  const errors = textAll(root, "string").filter((s) => s.trim().length > 0);
  const processed = textAll(root, "ProcessedMessage").filter((s) => s.trim().length > 0);
  const allErrors = [...errors, ...processed];

  if (isValid) {
    return { state: "accepted", statusCode, statusMessage, cufe, errors: [] };
  }
  if (zipKey) {
    return { state: "pending", statusCode, statusMessage, zipKey, errors: [] };
  }
  if (statusCode || allErrors.length > 0) {
    return { state: "rejected", statusCode, statusMessage, cufe, errors: allErrors };
  }
  return {
    state: "pending",
    statusCode,
    statusMessage: statusMessage ?? "en proceso",
    errors: [],
  };
}

// ── Transporte HTTP ─────────────────────────────────────────────────────────

export type SoapTransport = (
  url: string,
  action: string,
  envelope: string,
) => Promise<{ status: number; body: string }>;

export const fetchTransport: SoapTransport = async (url, action, envelope) => {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": `application/soap+xml;charset=UTF-8;action="${action}"`,
    },
    body: envelope,
    signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, body: await res.text() };
};

export type SendArgs = {
  environment: "habilitacion" | "produccion";
  cert: LoadedCert;
  transport?: SoapTransport;
};

async function call(
  service: string,
  bodyInner: string,
  args: SendArgs,
): Promise<DianResult> {
  const envelope = buildSignedSoapEnvelope(service, bodyInner, args.cert);
  const transport = args.transport ?? fetchTransport;
  let res: { status: number; body: string };
  try {
    res = await transport(
      DIAN_ENDPOINTS[args.environment],
      `${ACTION_BASE}/${service}`,
      envelope,
    );
  } catch (err) {
    return {
      state: "error",
      errors: [err instanceof Error ? err.message : "la DIAN no respondió"],
    };
  }
  if (!res.body) {
    return { state: "error", errors: ["la DIAN no respondió"] };
  }
  return parseDianResponse(res.body);
}

export async function sendBillSync(
  zip: Buffer,
  args: SendArgs,
): Promise<DianResult> {
  return call("SendBillSync", sendBillSyncBody("invoice.zip", zip.toString("base64")), args);
}
export async function sendTestSetAsync(
  zip: Buffer,
  testSetId: string,
  args: SendArgs,
): Promise<DianResult> {
  return call(
    "SendTestSetAsync",
    sendTestSetAsyncBody("invoice.zip", zip.toString("base64"), testSetId),
    args,
  );
}
export async function getStatus(trackId: string, args: SendArgs): Promise<DianResult> {
  return call("GetStatus", getStatusBody(trackId), args);
}
export async function getStatusZip(trackId: string, args: SendArgs): Promise<DianResult> {
  return call("GetStatusZip", getStatusZipBody(trackId), args);
}
