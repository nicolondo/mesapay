// Lectura del "subject" (DN) del certificado digital .p12 para poder
// MOSTRARLO en pantalla como información, no como un volcado.
//
// El DN que guardamos es una cadena tipo
//   "CN=SON Y MELONA S.A.S., O=SON Y MELONA S.A.S., L=ENVIGADO, C=CO"
// armada en `loadP12` (src/lib/dian/crypto.ts). Traía dos defectos que
// este módulo tiene que absorber, porque hay certificados YA guardados en
// la base con el texto roto y no se re-leen solos:
//
//  1. `undefined=9019444691` — atributos cuyo OID node-forge no conoce
//     (no tienen `shortName` ni `name`). Se muestran sin nombre de campo,
//     pero el VALOR nunca se pierde: suele ser el NIT o la cédula.
//  2. "LONDOÃ‘O" en vez de "LONDOÑO" — el .p12 se lee con
//     `toString("binary")` (latin1), así que los bytes UTF-8 del nombre
//     quedaron reinterpretados carácter a carácter. `fixLatin1Mojibake`
//     deshace eso cuando detecta la firma.

export type CertSubjectField = {
  /** shortName/name del atributo, o `null` si es un OID crudo o `undefined`. */
  key: string | null;
  value: string;
};

export type ParsedCertSubject = {
  commonName: string | null;
  organization: string | null;
  serialNumber: string | null;
  locality: string | null;
  state: string | null;
  country: string | null;
  /** TODOS los campos, en el orden original del DN y ya limpios. */
  fields: CertSubjectField[];
};

/** Un OID crudo: "2.5.4.5", "1.3.6.1.4.1.1234.1". */
const OID = /^[0-9]+(\.[0-9]+)+$/;

/**
 * Deshace el mojibake de UTF-8 leído como latin1 ("Ã‘" → "Ñ").
 *
 * Sólo actúa si TODOS los char codes caben en un byte (si hubiera un
 * carácter > 0xFF el texto ya está bien decodificado) y aparece la firma
 * del caso: un byte 0xC2–0xC3 seguido de uno de continuación 0x80–0xBF.
 * Ante cualquier duda devuelve el original: nunca tira ni corrompe texto
 * que ya estaba sano.
 */
export function fixLatin1Mojibake(raw: string): string {
  let suspicious = false;
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    // Fuera del rango latin1 ⇒ el string ya es texto decodificado.
    if (code > 0xff) return raw;
    if (!suspicious && (code === 0xc2 || code === 0xc3)) {
      const next = raw.charCodeAt(i + 1); // NaN al final: las comparaciones dan false
      if (next >= 0x80 && next <= 0xbf) suspicious = true;
    }
  }
  if (!suspicious) return raw;
  try {
    // `fatal` a propósito: si la reinterpretación no es UTF-8 válido
    // preferimos el original feo antes que basura distinta.
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(raw, (ch) => ch.charCodeAt(0) & 0xff),
    );
  } catch {
    return raw;
  }
}

/** shortName y nombre largo de cada campo que sabemos destacar. */
const ALIASES = {
  commonName: ["cn", "commonname"],
  organization: ["o", "organizationname"],
  serialNumber: ["serialnumber"],
  locality: ["l", "localityname"],
  state: ["st", "stateorprovincename"],
  country: ["c", "countryname"],
} as const;

function pick(fields: CertSubjectField[], aliases: readonly string[]): string | null {
  const hit = fields.find(
    (f) => f.key != null && aliases.includes(f.key.toLowerCase()),
  );
  return hit ? hit.value : null;
}

/**
 * Parte el DN en campos legibles.
 *
 * El corte es por coma SEGUIDA de `clave=`; una coma suelta dentro de un
 * valor ("O=SON Y MELONA, S.A.S.") no parte nada. Cada parte se corta en
 * el PRIMER `=` porque los valores pueden traer más.
 */
export function parseCertSubject(raw: string): ParsedCertSubject {
  const fields: CertSubjectField[] = [];
  for (const part of raw.split(/,\s*(?=[^,=]+=)/)) {
    const eq = part.indexOf("=");
    // Sin "=" no hay clave; conservamos el texto como valor suelto antes
    // que perderlo.
    const rawKey = eq === -1 ? "" : part.slice(0, eq).trim();
    const value = fixLatin1Mojibake(eq === -1 ? part : part.slice(eq + 1)).trim();
    if (!value) continue;
    const known = rawKey !== "" && rawKey !== "undefined" && !OID.test(rawKey);
    fields.push({ key: known ? rawKey : null, value });
  }
  return {
    commonName: pick(fields, ALIASES.commonName),
    organization: pick(fields, ALIASES.organization),
    serialNumber: pick(fields, ALIASES.serialNumber),
    locality: pick(fields, ALIASES.locality),
    state: pick(fields, ALIASES.state),
    country: pick(fields, ALIASES.country),
    fields,
  };
}
