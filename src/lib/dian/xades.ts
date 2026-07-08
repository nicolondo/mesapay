// Firma XAdES-EPES para documentos DIAN (ERP B1.2) — sin DB.
//
// Implementada desde el Anexo Técnico 1.9 + política de firma v2 de la
// DIAN (públicos). Enfoque de plantilla (como exige XAdES): la firma se
// inserta en el documento con los DigestValue vacíos, se canonicaliza
// (C14N 1.0 inclusiva) cada referencia con los namespaces heredados de
// sus ancestros, se llenan los digests SHA-256, se canonicaliza el
// SignedInfo y se firma RSA-SHA256 con la llave del certificado del
// comercio. El sanity verifica la firma resultante con un verificador
// independiente (xml-crypto).
import { createHash, randomUUID } from "crypto";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { C14nCanonicalization } from "xml-crypto";
import forge from "node-forge";
import type { LoadedCert } from "@/lib/dian/crypto";

const DS = "http://www.w3.org/2000/09/xmldsig#";

// Política de firma v2 de la DIAN (URL + SHA-256 del PDF, valores
// públicos del anexo).
const POLICY_URL =
  "https://facturaelectronica.dian.gov.co/politicadefirma/v2/politicadefirmav2.pdf";
const POLICY_HASH = "dMoMvtcG5aIzgYo0tIsSQeVJBDnUnfSOfBpxXrmor0Y=";

type XmlNode = NonNullable<ReturnType<DOMParser["parseFromString"]>["documentElement"]>;

function sha256b64(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("base64");
}

/** Namespaces en alcance heredados de los ANCESTROS de un nodo. */
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

/** C14N 1.0 inclusiva de un subtree, con los ns heredados de ancestros. */
function c14n(node: XmlNode): string {
  const canon = new C14nCanonicalization();
  return canon.process(node as never, {
    ancestorNamespaces: ancestorNamespaces(node),
  }) as string;
}

function findByTag(root: XmlNode, ns: string, local: string): XmlNode | null {
  const list = (root as unknown as Element).getElementsByTagNameNS(ns, local);
  return (list.length > 0 ? (list.item(0) as unknown as XmlNode) : null);
}

/** RFC 4514 (CN=...,O=...,C=...) — orden inverso al de forge. */
function issuerRfc4514(cert: forge.pki.Certificate): string {
  return [...cert.issuer.attributes]
    .reverse()
    .map((a) => `${a.shortName ?? a.name}=${a.value}`)
    .join(",");
}

/** Serial del certificado en decimal (forge lo expone en hex). */
function serialDecimal(cert: forge.pki.Certificate): string {
  return BigInt("0x" + cert.serialNumber).toString(10);
}

function signatureTemplate(vals: {
  sigId: string;
  certB64: string;
  signingTime: string;
  certDigest: string;
  issuerName: string;
  serial: string;
}): string {
  const { sigId } = vals;
  // Los ns ds/xades se declaran en los nodos referenciados además del
  // Signature — canonical estable e independiente del serializador.
  return (
    `<ds:Signature xmlns:ds="${DS}" Id="${sigId}">` +
    `<ds:SignedInfo>` +
    `<ds:CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"></ds:CanonicalizationMethod>` +
    `<ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"></ds:SignatureMethod>` +
    `<ds:Reference Id="${sigId}-ref0" URI="">` +
    `<ds:Transforms>` +
    `<ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"></ds:Transform>` +
    `</ds:Transforms>` +
    `<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod>` +
    `<ds:DigestValue></ds:DigestValue>` +
    `</ds:Reference>` +
    `<ds:Reference URI="#${sigId}-keyinfo">` +
    `<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod>` +
    `<ds:DigestValue></ds:DigestValue>` +
    `</ds:Reference>` +
    `<ds:Reference Type="http://uri.etsi.org/01903#SignedProperties" URI="#${sigId}-signedprops">` +
    `<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod>` +
    `<ds:DigestValue></ds:DigestValue>` +
    `</ds:Reference>` +
    `</ds:SignedInfo>` +
    `<ds:SignatureValue Id="${sigId}-sigvalue"></ds:SignatureValue>` +
    `<ds:KeyInfo Id="${sigId}-keyinfo">` +
    `<ds:X509Data><ds:X509Certificate>${vals.certB64}</ds:X509Certificate></ds:X509Data>` +
    `</ds:KeyInfo>` +
    `<ds:Object>` +
    `<xades:QualifyingProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Target="#${sigId}">` +
    `<xades:SignedProperties xmlns:ds="${DS}" xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Id="${sigId}-signedprops">` +
    `<xades:SignedSignatureProperties>` +
    `<xades:SigningTime>${vals.signingTime}</xades:SigningTime>` +
    `<xades:SigningCertificate><xades:Cert>` +
    `<xades:CertDigest>` +
    `<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod>` +
    `<ds:DigestValue>${vals.certDigest}</ds:DigestValue>` +
    `</xades:CertDigest>` +
    `<xades:IssuerSerial>` +
    `<ds:X509IssuerName>${vals.issuerName}</ds:X509IssuerName>` +
    `<ds:X509SerialNumber>${vals.serial}</ds:X509SerialNumber>` +
    `</xades:IssuerSerial>` +
    `</xades:Cert></xades:SigningCertificate>` +
    `<xades:SignaturePolicyIdentifier><xades:SignaturePolicyId>` +
    `<xades:SigPolicyId><xades:Identifier>${POLICY_URL}</xades:Identifier></xades:SigPolicyId>` +
    `<xades:SigPolicyHash>` +
    `<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod>` +
    `<ds:DigestValue>${POLICY_HASH}</ds:DigestValue>` +
    `</xades:SigPolicyHash>` +
    `</xades:SignaturePolicyId></xades:SignaturePolicyIdentifier>` +
    `<xades:SignerRole><xades:ClaimedRoles><xades:ClaimedRole>supplier</xades:ClaimedRole></xades:ClaimedRoles></xades:SignerRole>` +
    `</xades:SignedSignatureProperties>` +
    `</xades:SignedProperties>` +
    `</xades:QualifyingProperties>` +
    `</ds:Object>` +
    `</ds:Signature>`
  );
}

export class DianSignError extends Error {
  constructor(public code: "no_extension_slot" | "sign_failed") {
    super(code);
  }
}

/**
 * Firma un XML UBL DIAN: inserta la firma XAdES-EPES en el ÚLTIMO
 * `ext:ExtensionContent` VACÍO del documento (el builder de B1.3 deja
 * ese slot). Devuelve el XML firmado.
 */
export function signXmlDian(
  xml: string,
  cert: LoadedCert,
  opts: { signingTime?: string } = {},
): string {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const root = doc.documentElement!;

  // Slot: último ExtensionContent sin hijos-elemento.
  const contents = (root as unknown as Element).getElementsByTagNameNS(
    "urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2",
    "ExtensionContent",
  );
  let slot: Element | null = null;
  for (let i = contents.length - 1; i >= 0; i--) {
    const el = contents.item(i)!;
    let hasElementChild = false;
    for (let j = 0; j < el.childNodes.length; j++) {
      if (el.childNodes.item(j)!.nodeType === 1) hasElementChild = true;
    }
    if (!hasElementChild) { slot = el as unknown as Element; break; }
  }
  if (!slot) throw new DianSignError("no_extension_slot");
  const slotNode = slot as unknown as XmlNode;

  const forgeCert = forge.pki.certificateFromPem(cert.certPem);
  const sigId = "xmldsig-" + randomUUID();
  const signingTime = opts.signingTime ?? new Date().toISOString().replace(/\.\d{3}Z$/, "-05:00");
  const certDer = Buffer.from(forge.util.decode64(cert.certDerBase64), "binary");

  const sigDoc = new DOMParser().parseFromString(
    signatureTemplate({
      sigId,
      certB64: cert.certDerBase64,
      signingTime,
      certDigest: sha256b64(certDer),
      issuerName: issuerRfc4514(forgeCert),
      serial: serialDecimal(forgeCert),
    }),
    "text/xml",
  );
  const sigNode = doc.importNode(sigDoc.documentElement!, true);
  slotNode.appendChild(sigNode as never);

  const signature = sigNode as unknown as XmlNode;
  const signedInfo = findByTag(signature, DS, "SignedInfo")!;
  const keyInfo = findByTag(signature, DS, "KeyInfo")!;
  const signedProps = findByTag(
    signature,
    "http://uri.etsi.org/01903/v1.3.2#",
    "SignedProperties",
  )!;
  const digestValues = (signedInfo as unknown as Element).getElementsByTagNameNS(DS, "DigestValue");

  // Ref 0 (URI=""): documento completo con la firma REMOVIDA (enveloped).
  const parent = (sigNode as unknown as XmlNode).parentNode! as XmlNode;
  parent.removeChild(sigNode as never);
  const docDigest = sha256b64(c14n(root));
  parent.appendChild(sigNode as never);
  digestValues.item(0)!.appendChild(doc.createTextNode(docDigest) as never);

  // Ref 1: KeyInfo · Ref 2: SignedProperties (con ns heredados).
  digestValues.item(1)!.appendChild(doc.createTextNode(sha256b64(c14n(keyInfo))) as never);
  digestValues.item(2)!.appendChild(doc.createTextNode(sha256b64(c14n(signedProps))) as never);

  // Firmar el SignedInfo canonicalizado.
  const canonSignedInfo = c14n(signedInfo);
  const md = forge.md.sha256.create();
  md.update(canonSignedInfo, "utf8");
  let signatureB64: string;
  try {
    const key = forge.pki.privateKeyFromPem(cert.keyPem);
    signatureB64 = forge.util.encode64(key.sign(md));
  } catch {
    throw new DianSignError("sign_failed");
  }
  findByTag(signature, DS, "SignatureValue")!.appendChild(
    doc.createTextNode(signatureB64) as never,
  );

  return new XMLSerializer().serializeToString(doc as never);
}
