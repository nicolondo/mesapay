// Lectura PURA de los XML de la DIAN que guardamos (factura firmada y acuse):
// número y CUFE. Sin dependencias para que la usen el correo, la consulta
// por CUFE y la pantalla sin ciclos de imports.

/**
 * Número (`cbc:ID`) y CUFE (`cbc:UUID`) de un XML de factura. Se leen
 * DESPUÉS de las extensiones: ahí adentro hay `sts:` y fechas, pero el
 * primer `cbc:ID` del documento es el número.
 */
export function invoiceXmlIdentity(xml: string): { number: string | null; cufe: string | null } {
  const body = xml.includes("</ext:UBLExtensions>") ? xml.split("</ext:UBLExtensions>")[1] : xml;
  const number = /<cbc:ID\b[^>]*>([^<]+)<\/cbc:ID>/.exec(body)?.[1]?.trim() ?? null;
  const cufe = /<cbc:UUID\b[^>]*>([^<]+)<\/cbc:UUID>/.exec(body)?.[1]?.trim() ?? null;
  return { number, cufe };
}

/**
 * El documento al que se refiere un acuse (ApplicationResponse):
 * `cac:DocumentResponse/cac:DocumentReference` → número y CUFE. El UUID
 * raíz del acuse es el del acuse, NO el de la factura (mismo cuidado que
 * `creditNoteResponse.ts`).
 */
export function applicationResponseReference(
  xml: string | null | undefined,
): { number: string | null; cufe: string | null } | null {
  if (!xml) return null;
  const ref = /<(?:\w+:)?DocumentReference\b[^>]*>([\s\S]*?)<\/(?:\w+:)?DocumentReference>/.exec(xml)?.[1];
  if (!ref) return null;
  const number = /<(?:\w+:)?ID\b[^>]*>([^<]+)<\/(?:\w+:)?ID>/.exec(ref)?.[1]?.trim() ?? null;
  const cufe = /<(?:\w+:)?UUID\b[^>]*>([^<]+)<\/(?:\w+:)?UUID>/.exec(ref)?.[1]?.trim() ?? null;
  return { number, cufe };
}
