// xades:SigningTime: hora legal colombiana. Antes era el reloj UTC con un
// "-05:00" pegado — una firma cinco horas en el futuro y, de 7 p. m. en
// adelante, del día siguiente al que declaraba la factura.
import { generateKeyPairSync } from "crypto";
import forge from "node-forge";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { signXmlDian } from "./xades";
import type { LoadedCert } from "./crypto";

let cert: LoadedCert;

beforeAll(() => {
  // Certificado autofirmado de prueba: la firma corre de verdad.
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const c = forge.pki.createCertificate();
  c.publicKey = forge.pki.publicKeyFromPem(pubPem);
  c.serialNumber = "01";
  c.validity.notBefore = new Date("2026-01-01T00:00:00Z");
  c.validity.notAfter = new Date("2028-01-01T00:00:00Z");
  const attrs = [{ name: "commonName", value: "PRUEBA MESAPAY" }];
  c.setSubject(attrs);
  c.setIssuer(attrs);
  c.sign(forge.pki.privateKeyFromPem(keyPem), forge.md.sha256.create());
  cert = {
    certPem: forge.pki.certificateToPem(c),
    keyPem,
    subject: "CN=PRUEBA MESAPAY",
    issuer: "CN=PRUEBA MESAPAY",
    notBefore: c.validity.notBefore,
    notAfter: c.validity.notAfter,
    certDerBase64: forge.util.encode64(
      forge.asn1.toDer(forge.pki.certificateToAsn1(c)).getBytes(),
    ),
  };
});

afterEach(() => {
  vi.useRealTimers();
});

const XML =
  `<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" ` +
  `xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">` +
  `<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent></ext:ExtensionContent></ext:UBLExtension></ext:UBLExtensions>` +
  `</Invoice>`;

const signingTimeOf = (signed: string) =>
  signed.match(/<xades:SigningTime>([^<]+)<\/xades:SigningTime>/)?.[1];

describe("xades:SigningTime", () => {
  it("sin hora explícita: la hora de Bogotá de ahora, no la UTC con '-05:00' pegado", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // 30/09 a las 8 p. m. en Bogotá = 01:00 UTC del 1/10.
    vi.setSystemTime(new Date("2026-10-01T01:00:00.000Z"));
    const signed = signXmlDian(XML, cert);
    expect(signingTimeOf(signed)).toBe("2026-09-30T20:00:00-05:00");
  });

  it("con hora explícita (la de la emisión) la usa tal cual", () => {
    const signed = signXmlDian(XML, cert, { signingTime: "2026-09-15T21:00:00-05:00" });
    expect(signingTimeOf(signed)).toBe("2026-09-15T21:00:00-05:00");
  });
});
