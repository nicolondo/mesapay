// Base criptográfica de la facturación DIAN (ERP B1) — sin DB.
//
// Implementado desde el Anexo Técnico de Factura Electrónica de Venta
// v1.9 (público, dian.gov.co). Cubre: cifrado at rest de secretos del
// comercio (certificado .p12, contraseña, PIN), carga/validación del
// certificado, CUFE/CUDE (SHA-384) y la URL del QR. La firma XAdES vive
// en src/lib/dian/xades.ts (B1.2).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import forge from "node-forge";

// ── Cifrado at rest (AES-256-GCM) ───────────────────────────────────────────
//
// DIAN_MASTER_KEY: 32 bytes en hex (64 chars) — env del server, nunca en
// el repo. Formato del ciphertext: base64(iv[12] | tag[16] | data).

function masterKey(): Buffer {
  const hex = process.env.DIAN_MASTER_KEY ?? "";
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("DIAN_MASTER_KEY inválida o ausente (esperado: 32 bytes hex)");
  }
  return Buffer.from(hex, "hex");
}

export function encryptSecret(plaintext: Buffer, key: Buffer = masterKey()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}

export function decryptSecret(ciphertext: string, key: Buffer = masterKey()): Buffer {
  const raw = Buffer.from(ciphertext, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

// ── Certificado .p12 ────────────────────────────────────────────────────────

export type LoadedCert = {
  certPem: string;
  keyPem: string;
  subject: string;
  issuer: string;
  notBefore: Date;
  notAfter: Date;
  /** DER del certificado en base64 — BinarySecurityToken del SOAP (B1.3). */
  certDerBase64: string;
};

export class DianCertError extends Error {
  constructor(public code: "bad_password" | "no_key" | "no_cert" | "invalid") {
    super(code);
  }
}

/** Carga un .p12: extrae certificado + llave privada y metadatos. */
export function loadP12(p12Der: Buffer, password: string): LoadedCert {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(p12Der.toString("binary")));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, password);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    throw new DianCertError(
      /invalid password|mac/i.test(msg) ? "bad_password" : "invalid",
    );
  }
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];
  const keyBags =
    p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ??
    p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ??
    [];
  // El bag del certificado del titular es el que empareja con la llave;
  // tomamos el primero con cert (los .p12 de las CA traen la cadena).
  const cert = certBags.find((b) => b.cert)?.cert;
  const key = keyBags.find((b) => b.key)?.key;
  if (!cert) throw new DianCertError("no_cert");
  if (!key) throw new DianCertError("no_key");

  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(key),
    subject: cert.subject.attributes
      .map((a) => `${a.shortName ?? a.name}=${a.value}`)
      .join(", "),
    issuer: cert.issuer.attributes
      .map((a) => `${a.shortName ?? a.name}=${a.value}`)
      .join(", "),
    notBefore: cert.validity.notBefore,
    notAfter: cert.validity.notAfter,
    certDerBase64: forge.util.encode64(der),
  };
}

// ── CUFE / CUDE (Anexo Técnico 1.9, SHA-384) ────────────────────────────────
//
// CUFE  (factura): NumFac + FecFac + HorFac + ValFac + "01" + ValImp1 +
//   "04" + ValImp2 + "03" + ValImp3 + ValTot + NitOFE + NumAdq + ClTec +
//   TipoAmbiente
// CUDE (nota crédito/débito): igual pero con el Software PIN en vez de
//   la clave técnica.
// Montos: string con EXACTAMENTE 2 decimales y punto (formato del XML).

export type CufeInputs = {
  /** Número completo del documento (prefijo + consecutivo, ej. "SETP990000001"). */
  invoiceNumber: string;
  /** "YYYY-MM-DD" */
  issueDate: string;
  /** "HH:mm:ss-05:00" (hora local CON offset, igual que el XML). */
  issueTime: string;
  /** Subtotal (LineExtensionAmount), "1500000.00". */
  lineExtensionAmount: string;
  /** IVA (01), impoconsumo (04) e ICA (03) — "0.00" si no aplican. */
  taxIva: string;
  taxInc: string;
  taxIca: string;
  /** Total a pagar (PayableAmount). */
  payableAmount: string;
  /** NIT del emisor SIN dígito de verificación. */
  supplierNit: string;
  /** Identificación del adquirente (NIT/CC; consumidor final = 222222222222). */
  customerId: string;
  /** Clave técnica (CUFE) o Software PIN (CUDE). */
  key: string;
  /** ProfileExecutionID: "1" producción, "2" habilitación. */
  environment: "1" | "2";
};

/** Concatenación EXACTA del anexo — expuesta para el sanity. */
export function cufePlainText(i: CufeInputs, kind: "cufe" | "cude" = "cufe"): string {
  const taxes =
    kind === "cufe"
      ? `01${i.taxIva}04${i.taxInc}03${i.taxIca}`
      : ""; // CUDE omite los bloques de impuestos por código
  return (
    i.invoiceNumber +
    i.issueDate +
    i.issueTime +
    i.lineExtensionAmount +
    taxes +
    i.payableAmount +
    i.supplierNit +
    i.customerId +
    i.key +
    i.environment
  );
}

export function computeCufe(i: CufeInputs, kind: "cufe" | "cude" = "cufe"): string {
  return createHash("sha384").update(cufePlainText(i, kind), "utf8").digest("hex");
}

// ── QR (catálogo DIAN) ──────────────────────────────────────────────────────

export function dianQrUrl(cufe: string, environment: "1" | "2"): string {
  const host =
    environment === "1"
      ? "https://catalogo-vpfe.dian.gov.co"
      : "https://catalogo-vpfe-hab.dian.gov.co";
  return `${host}/document/searchqr?documentkey=${cufe}`;
}

/** Formatea centavos al string de montos del XML/CUFE ("1500000.00"). */
export function centsToDianAmount(cents: number): string {
  return (cents / 100).toFixed(2);
}
