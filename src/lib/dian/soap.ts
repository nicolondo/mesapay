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

export type DianEnvironment = keyof typeof DIAN_ENDPOINTS;

// ── ZIP del documento (la DIAN recibe el XML zippeado en base64) ────────────

export async function zipInvoice(fileName: string, xml: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(fileName, xml);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/**
 * Saca el primer .xml de un zip. Es la vuelta de `zipInvoice`: lo que se
 * envió a la DIAN queda guardado comprimido en `DianDocument.xmlZip`, y
 * para armar el AttachedDocument hay que recuperar ese MISMO XML firmado
 * (no se puede reconstruir: el CUFE y la firma dependen del instante de
 * emisión). null si el zip está vacío o ilegible.
 */
export async function unzipFirstXml(zip: Buffer | Uint8Array): Promise<string | null> {
  try {
    const loaded = await JSZip.loadAsync(zip);
    const entry = Object.values(loaded.files).find(
      (f) => !f.dir && /\.xml$/i.test(f.name),
    );
    if (!entry) return null;
    return await entry.async("string");
  } catch {
    return null;
  }
}

/**
 * Extrae el ApplicationResponse (el acuse de aceptación) de la respuesta
 * CRUDA de la DIAN que quedó en `DianDocument.responseXml`.
 *
 * El acuse no viaja como XML dentro del SOAP: viaja en `XmlBase64Bytes`, y
 * QUÉ hay adentro depende de la operación — SendBillSync y GetStatus
 * devuelven el ApplicationResponse pelado, GetStatusZip devuelve un ZIP que
 * lo contiene. Por eso se mira la firma "PK" de los bytes decodificados en
 * vez de confiar en el nombre del servicio: los dos rieles de aceptación
 * (envío síncrono y consulta diferida) pasan por acá.
 *
 * null si la respuesta no trae acuse (rechazo, fault, o un documento viejo
 * emitido antes de que se guardara la respuesta cruda).
 */
export async function extractApplicationResponse(
  responseXml: string | null | undefined,
): Promise<string | null> {
  if (!responseXml) return null;
  let root: XmlNode;
  try {
    root = new DOMParser().parseFromString(responseXml, "text/xml")
      .documentElement as unknown as XmlNode;
  } catch {
    return null;
  }
  const b64 = text1(root, "XmlBase64Bytes")?.trim();
  if (!b64) return null;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(b64, "base64");
  } catch {
    return null;
  }
  if (bytes.length === 0) return null;
  // "PK" (0x50 0x4b) = zip. GetStatusZip devuelve el acuse comprimido.
  const xml =
    bytes[0] === 0x50 && bytes[1] === 0x4b
      ? await unzipFirstXml(bytes)
      : bytes.toString("utf8");
  if (!xml) return null;
  // Guardarraíl barato: si lo que salió no es un acuse, mejor mandar el
  // correo sin adjunto que adjuntar un sobre con basura adentro.
  return xml.includes("ApplicationResponse") ? xml : null;
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
  environment: DianEnvironment = "produccion",
  now: () => string = () => nowPlus(0),
): string {
  const tokenId = "X509-" + randomUUID();
  const strId = "STR-" + randomUUID();
  const tsId = "TS-" + randomUUID();
  const toId = "To-" + randomUUID();
  const sigId = "SIG-" + randomUUID();
  const created = now();
  const expires = nowPlus(60);

  // El wsa:To DEBE ser el endpoint real al que se postea: la DIAN lo compara
  // y con el de producción apuntando a habilitación responde InvalidSecurity.
  const to = DIAN_ENDPOINTS[environment];

  const template =
    `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" ` +
    `xmlns:wcf="http://wcf.dian.colombia" ` +
    `xmlns:wsa="http://www.w3.org/2005/08/addressing" xmlns:wsu="${WSU}">` +
    `<soap:Header>` +
    `<wsse:Security xmlns:wsse="${WSSE}" soap:mustUnderstand="true">` +
    // ORDEN OBLIGATORIO: Timestamp, luego el token, luego la firma. Con el
    // Timestamp al final la DIAN responde InvalidSecurity (verificado).
    `<wsu:Timestamp wsu:Id="${tsId}">` +
    `<wsu:Created>${created}</wsu:Created><wsu:Expires>${expires}</wsu:Expires>` +
    `</wsu:Timestamp>` +
    `<wsse:BinarySecurityToken EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary" ` +
    `ValueType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3" ` +
    `wsu:Id="${tokenId}">${cert.certDerBase64}</wsse:BinarySecurityToken>` +
    `<ds:Signature xmlns:ds="${DS}" Id="${sigId}">` +
    `<ds:SignedInfo>` +
    `<ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></ds:CanonicalizationMethod>` +
    `<ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"></ds:SignatureMethod>` +
    // Se firma ÚNICAMENTE el wsa:To, y sin InclusiveNamespaces/PrefixList.
    // Agregar más referencias (Timestamp, Body, Action) o el PrefixList hace
    // que la DIAN rechace con InvalidSecurity (verificado contra vpfe-hab).
    `<ds:Reference URI="#${toId}">` +
    `<ds:Transforms><ds:Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></ds:Transform></ds:Transforms>` +
    `<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod>` +
    `<ds:DigestValue></ds:DigestValue>` +
    `</ds:Reference>` +
    `</ds:SignedInfo>` +
    `<ds:SignatureValue></ds:SignatureValue>` +
    `<ds:KeyInfo>` +
    `<wsse:SecurityTokenReference wsu:Id="${strId}">` +
    `<wsse:Reference URI="#${tokenId}" ValueType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3"></wsse:Reference>` +
    `</wsse:SecurityTokenReference>` +
    `</ds:KeyInfo>` +
    `</ds:Signature>` +
    `</wsse:Security>` +
    `<wsa:Action>${ACTION_BASE}/${service}</wsa:Action>` +
    `<wsa:To wsu:Id="${toId}">${to}</wsa:To>` +
    `<wsa:MessageID>urn:uuid:${randomUUID()}</wsa:MessageID>` +
    `<wsa:ReplyTo><wsa:Address>http://www.w3.org/2005/08/addressing/anonymous</wsa:Address></wsa:ReplyTo>` +
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

  const toEl = findId(toId)!;
  const sig = findId(sigId)! as unknown as Element;
  const signedInfo = sig.getElementsByTagNameNS(DS, "SignedInfo").item(0)! as unknown as XmlNode;
  const digestValue = sig.getElementsByTagNameNS(DS, "DigestValue").item(0)!;
  const signatureValue = sig.getElementsByTagNameNS(DS, "SignatureValue").item(0)!;

  digestValue.appendChild(doc.createTextNode(sha256b64(excC14n(toEl))) as never);
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
  /** Respuesta cruda de la DIAN — se persiste para poder diagnosticar. */
  raw?: string;
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

  // SOAP Fault: la DIAN rechazó el mensaje ANTES de mirar el documento
  // (típicamente InvalidSecurity). Es un error de canal, no un trámite en
  // curso — antes caía en el `pending` de abajo y se mostraba "en proceso".
  const faultReason = text1(root, "Text") ?? text1(root, "faultstring");
  if (textAll(root, "Fault").length > 0 || faultReason) {
    // El código útil es el del Subcode ("a:InvalidSecurity"), no el genérico
    // del Code ("s:Sender"): sin esto el error quedaba como "s:Sender: An
    // error occurred…", que no dice qué pasó. Se cae al primer Value con ":"
    // sólo si el Fault viene sin Subcode.
    const subcode =
      text1(root, "Subcode")?.trim() ||
      textAll(root, "Value").find((v) => v.includes(":")) ||
      null;
    return {
      state: "error",
      statusCode: subcode,
      statusMessage: faultReason,
      errors: [
        subcode ? `${subcode}: ${faultReason ?? "rechazado por la DIAN"}` : (faultReason ?? "rechazado por la DIAN"),
      ],
    };
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
  // La DIAN todavía está validando el lote: se vuelve a consultar, NO es un
  // fallo. Hay que detectarlo por el texto porque el anexo no le asigna
  // código (StatusCode llega vacío) y no hay reglas todavía; sin esto el
  // documento en curso se mostraba como "error" (ver isStillValidating).
  if (allErrors.length === 0 && isStillValidating(root)) {
    return { state: "pending", statusCode, statusMessage, errors: [] };
  }
  if (statusCode || allErrors.length > 0) {
    return { state: "rejected", statusCode, statusMessage, cufe, errors: allErrors };
  }
  // Sin Fault, sin IsValid, sin ZipKey, sin StatusCode y sin "en proceso": la
  // respuesta no se entiende. Es un error, NO un pendiente — dar por sentado
  // "en curso" ante cualquier cosa desconocida ocultaba fallos reales.
  return {
    state: "error",
    statusCode,
    statusMessage,
    errors: ["respuesta no reconocida de la DIAN"],
  };
}

/**
 * ¿La respuesta dice que el lote sigue en validación?
 *
 * La DIAN no publica un código para este estado (la tabla de StatusCode del
 * anexo sólo tiene 00, 66, 90 y 99) y de hecho lo devuelve VACÍO: el único
 * indicio es el texto. Verificado contra vpfe-hab consultando GetStatusZip
 * inmediatamente después de enviar:
 *
 *   <b:ErrorMessage i:nil="true"/><b:IsValid>false</b:IsValid>
 *   <b:StatusCode/><b:StatusDescription>Batch en proceso de validación.
 *   </b:StatusDescription><b:StatusMessage i:nil="true"/>
 *
 * Se mira tanto StatusDescription como StatusMessage porque cuál de los dos
 * trae la frase depende de la operación (GetStatus / GetStatusZip).
 */
function isStillValidating(root: XmlNode): boolean {
  const texts = [...textAll(root, "StatusDescription"), ...textAll(root, "StatusMessage")];
  return texts.some((t) => /en proceso/i.test(t));
}

// ── Transporte HTTP ─────────────────────────────────────────────────────────

export type SoapTransport = (
  url: string,
  action: string,
  envelope: string,
) => Promise<{ status: number; body: string }>;

/** `charset=` del Content-Type, o null. */
function charsetOf(contentType: string | null | undefined): string | null {
  const m = /charset\s*=\s*"?([\w.:-]+)"?/i.exec(contentType ?? "");
  return m ? m[1] : null;
}

/** `encoding="…"` de la declaración XML (los primeros bytes, en ASCII). */
function xmlDeclaredEncoding(bytes: Uint8Array): string | null {
  const head = Buffer.from(bytes.subarray(0, 200)).toString("latin1");
  const m = /^\s*<\?xml[^>]*\bencoding\s*=\s*["']([\w.:-]+)["']/i.exec(head);
  return m ? m[1] : null;
}

/**
 * Texto de la respuesta de la DIAN a partir de los BYTES, con el juego de
 * caracteres correcto.
 *
 * `Response.text()` decodifica SIEMPRE como UTF-8, diga lo que diga el
 * servidor. Cuando la DIAN responde en ISO-8859-1 / windows-1252 (pasa con
 * algunos mensajes de reglas, p. ej. RUT01), cada letra con tilde o «ñ» se
 * convertía en «�» (U+FFFD) y así quedaba guardado: «Se�or usuario…».
 * Orden: el charset declarado (Content-Type o declaración XML) si no es
 * UTF-8; si no, UTF-8 ESTRICTO; y si los bytes no son UTF-8 válido —un
 * servidor que dice UTF-8 y manda Latin-1—, windows-1252, que es el
 * superconjunto de Latin-1 que usan los servidores Windows.
 */
export function decodeSoapBody(
  bytes: Uint8Array,
  contentType?: string | null,
): string {
  const declared = charsetOf(contentType) ?? xmlDeclaredEncoding(bytes);
  if (declared && !/^utf-?8$/i.test(declared)) {
    try {
      return new TextDecoder(declared).decode(bytes);
    } catch {
      // Charset desconocido: se sigue con la detección de abajo.
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

export const fetchTransport: SoapTransport = async (url, action, envelope) => {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": `application/soap+xml;charset=UTF-8;action="${action}"`,
    },
    body: envelope,
    signal: AbortSignal.timeout(30_000),
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, body: decodeSoapBody(bytes, res.headers.get("content-type")) };
};

export type SendArgs = {
  /** Optional immutable DIAN archive name; existing invoice callers keep their default. */
  fileName?: string;
  environment: "habilitacion" | "produccion";
  cert: LoadedCert;
  transport?: SoapTransport;
};

/** Envía la operación firmada y devuelve el cuerpo crudo (o el fallo de canal). */
async function post(
  service: string,
  bodyInner: string,
  args: SendArgs,
): Promise<{ body: string } | { error: string }> {
  const envelope = buildSignedSoapEnvelope(service, bodyInner, args.cert, args.environment);
  const transport = args.transport ?? fetchTransport;
  let res: { status: number; body: string };
  try {
    res = await transport(
      DIAN_ENDPOINTS[args.environment],
      `${ACTION_BASE}/${service}`,
      envelope,
    );
  } catch (err) {
    return { error: err instanceof Error ? err.message : "la DIAN no respondió" };
  }
  if (!res.body) return { error: "la DIAN no respondió" };
  return { body: res.body };
}

async function call(
  service: string,
  bodyInner: string,
  args: SendArgs,
): Promise<DianResult> {
  const res = await post(service, bodyInner, args);
  if ("error" in res) return { state: "error", errors: [res.error] };
  return { ...parseDianResponse(res.body), raw: res.body };
}

export async function sendBillSync(
  zip: Buffer,
  args: SendArgs,
): Promise<DianResult> {
  return call("SendBillSync", sendBillSyncBody(args.fileName ?? "invoice.zip", zip.toString("base64")), args);
}
export async function sendTestSetAsync(
  zip: Buffer,
  testSetId: string,
  args: SendArgs,
): Promise<DianResult> {
  return call(
    "SendTestSetAsync",
    sendTestSetAsyncBody(args.fileName ?? "invoice.zip", zip.toString("base64"), testSetId),
    args,
  );
}
export async function getStatus(trackId: string, args: SendArgs): Promise<DianResult> {
  return call("GetStatus", getStatusBody(trackId), args);
}
export async function getStatusZip(trackId: string, args: SendArgs): Promise<DianResult> {
  return call("GetStatusZip", getStatusZipBody(trackId), args);
}

export function getXmlByDocumentKeyBody(trackId: string): string {
  return `<wcf:trackId>${trackId}</wcf:trackId>`;
}

/**
 * Saca el XML de un documento de la respuesta de `GetXmlByDocumentKey`: el
 * documento viaja en base64 (`XmlBytesBase64`), pelado o zipeado. null si
 * la respuesta no trae un XML de factura (documento inexistente, fault,
 * respuesta ilegible). Pura, para poder probarla sin red.
 */
export async function documentXmlFromResponse(
  responseXml: string | null | undefined,
): Promise<string | null> {
  if (!responseXml) return null;
  let root: XmlNode;
  try {
    root = new DOMParser().parseFromString(responseXml, "text/xml")
      .documentElement as unknown as XmlNode;
  } catch {
    return null;
  }
  if (!root) return null;
  const b64 = (text1(root, "XmlBytesBase64") ?? text1(root, "XmlBase64Bytes"))?.trim();
  if (!b64) return null;
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length === 0) return null;
  const xml =
    bytes[0] === 0x50 && bytes[1] === 0x4b
      ? await unzipFirstXml(bytes)
      : decodeSoapBody(bytes);
  if (!xml) return null;
  // Sólo una factura: el acuse (ApplicationResponse) no sirve como XML del
  // documento y nunca debe guardarse en su lugar.
  return /<(?:\w+:)?Invoice[\s>]/.test(xml) ? xml : null;
}

/**
 * El XML firmado que la DIAN tiene guardado para un CUFE
 * (`GetXmlByDocumentKey`, la misma clave que `GetStatus`). Sirve para
 * recuperar el documento EXACTO de un envío cuya respuesta se perdió: si
 * la DIAN aceptó un intento anterior, el XML que guardamos es el del
 * último intento y no el aceptado. Nunca lanza: null si no se pudo.
 */
export async function getXmlByDocumentKey(
  trackId: string,
  args: SendArgs,
): Promise<string | null> {
  const res = await post("GetXmlByDocumentKey", getXmlByDocumentKeyBody(trackId), args);
  if ("error" in res) return null;
  try {
    return await documentXmlFromResponse(res.body);
  } catch {
    return null;
  }
}
