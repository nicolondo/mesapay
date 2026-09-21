/**
 * Información exógena DIAN — generador del XML oficial (Resolución Única
 * 000227/2025 y 000233/2025). Port de `zenith-erp/packages/domain/src/
 * exogena-xml.ts`. Lógica pura, sin IO.
 *
 * Todos los formatos comparten la raíz <mas> y la cabecera <Cab>; cada
 * formato agrega registros con atributos en el orden de su anexo. Los
 * valores monetarios van en PESOS ENTEROS positivos, sin separadores
 * (MESAPAY guarda centavos: convertir con `pesos()`). El encoding
 * ISO-8859-1 lo aplica `toLatin1()` al armar la respuesta.
 */

import { computeNitDv } from "../exogena";

/* ────────────────────────────── Cabecera ────────────────────────────── */

export type CabInput = {
  formato: number;
  version: number;
  /** Año del ENVÍO (año gravable + 1). */
  anoEnvio: number;
  /** Consecutivo del envío por formato y año (1 en el primero). */
  numEnvio?: number;
  /** 1 inserción, 2 reemplazo. */
  codCpt?: 1 | 2;
  fecInicial: string;
  fecFinal: string;
  /** Pesos enteros. */
  valorTotal: number;
  cantReg: number;
  /** ISO datetime; default: ahora. */
  fecEnvio?: string;
};

export function xmlEscape(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function el(name: string, attrs: Record<string, string | number>): string {
  const body = Object.entries(attrs)
    .map(([k, v]) => `${k}="${xmlEscape(String(v))}"`)
    .join(" ");
  return `  <${name} ${body}/>`;
}

export function buildCab(i: CabInput): string {
  const fecEnvio = i.fecEnvio ?? new Date().toISOString().slice(0, 19);
  return [
    "<Cab>",
    `  <Ano>${i.anoEnvio}</Ano>`,
    `  <CodCpt>${i.codCpt ?? 1}</CodCpt>`,
    `  <Formato>${i.formato}</Formato>`,
    `  <Version>${i.version}</Version>`,
    `  <NumEnvio>${i.numEnvio ?? 1}</NumEnvio>`,
    `  <FecEnvio>${fecEnvio}</FecEnvio>`,
    `  <FecInicial>${i.fecInicial}</FecInicial>`,
    `  <FecFinal>${i.fecFinal}</FecFinal>`,
    `  <ValorTotal>${Math.round(i.valorTotal)}</ValorTotal>`,
    `  <CantReg>${i.cantReg}</CantReg>`,
    "</Cab>",
  ].join("\n");
}

/** Envuelve cabecera + registros en la raíz <mas>. */
export function buildXml(cab: string, records: string[]): string {
  return ['<?xml version="1.0" encoding="ISO-8859-1"?>', "<mas>", cab, ...records, "</mas>"].join(
    "\n",
  );
}

/** Nombre oficial del archivo: Dmuisca_01{formato 5 díg}{versión 2 díg}{año envío}00000001.xml */
export function dianFileName(formato: string, version: number, yearGravable: number): string {
  return `Dmuisca_01${formato.padStart(5, "0")}${String(version).padStart(2, "0")}${yearGravable + 1}00000001.xml`;
}

/**
 * El XML como bytes ISO-8859-1 (lo que exige el prevalidador). Se copia a
 * un `Uint8Array` sobre un `ArrayBuffer` propio porque `Response` no acepta
 * `Buffer` (ni un `Uint8Array<ArrayBufferLike>`) en TypeScript.
 */
export function toLatin1(xml: string): Uint8Array<ArrayBuffer> {
  const buf = Buffer.from(xml, "latin1");
  const out = new Uint8Array(new ArrayBuffer(buf.byteLength));
  out.set(buf);
  return out;
}

/** Centavos → pesos enteros (redondeo al peso). */
export function pesos(cents: number): number {
  return Math.round(cents / 100);
}

/* ─────────────────────────── Tipos de documento ──────────────────────────
   Del sistema (NIT, CC, CE, PA…) al CÓDIGO DIAN de la exógena: 31 NIT, 13
   CC, 22 CE, 41 pasaporte, 42 TI, 43 documento de extranjería / consumidor
   final, 11 registro civil. null = no mapeable (hay que corregir el tercero). */

const ID_TYPE_TO_DIAN: Record<string, string> = {
  NIT: "31",
  CC: "13",
  CE: "22",
  TI: "42",
  RC: "11",
  PA: "41",
  PPT: "41",
  PEP: "41",
  DEX: "43",
};

export function dianIdType(idType: string | null | undefined): string | null {
  if (!idType) return null;
  return ID_TYPE_TO_DIAN[idType.trim().toUpperCase()] ?? null;
}

/** Consumidor final / cuantías menores: NIT genérico y tipo 43. */
export const CUANTIAS_MENORES_NID = "222222222";
export const CUANTIAS_MENORES_TDOC = "43";
export const CUANTIAS_MENORES_RAZ = "CUANTÍAS MENORES";
export const CONSUMIDOR_FINAL_NID = "222222222222";
export const CONSUMIDOR_FINAL_RAZ = "CONSUMIDOR FINAL";
/** Código DIAN de país: Colombia. */
export const PAIS_COLOMBIA = "169";

/* ───────────────────────────── Terceros ────────────────────────────── */

export type ExogenaPerson = {
  kind: "natural" | "juridica";
  name: string;
};

/**
 * Divide un nombre de persona natural en apl1/apl2/nom1/nom2 (aproximación
 * estándar: última palabra → primer apellido, penúltima → segundo apellido,
 * primera → primer nombre, el resto → otros nombres).
 */
export function splitNaturalName(full: string): {
  apl1: string;
  apl2: string;
  nom1: string;
  nom2: string;
} {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { apl1: "", apl2: "", nom1: "", nom2: "" };
  if (parts.length === 1) return { apl1: parts[0]!, apl2: "", nom1: parts[0]!, nom2: "" };
  if (parts.length === 2) return { apl1: parts[1]!, apl2: "", nom1: parts[0]!, nom2: "" };
  const apl1 = parts[parts.length - 1]!;
  const apl2 = parts[parts.length - 2]!;
  const nom1 = parts[0]!;
  const nom2 = parts.slice(1, -2).join(" ");
  return { apl1, apl2, nom1, nom2 };
}

/** apl1/apl2/nom1/nom2 para natural; raz para jurídica (los otros vacíos). */
export function personAttrs(p: ExogenaPerson): Record<string, string> {
  if (p.kind === "natural") {
    const n = splitNaturalName(p.name);
    return { apl1: n.apl1, apl2: n.apl2, nom1: n.nom1, nom2: n.nom2, raz: "" };
  }
  return { apl1: "", apl2: "", nom1: "", nom2: "", raz: p.name };
}

/** tdoc/nid/dv según tipo DIAN (dv SOLO para NIT '31'; '' si no). */
export function terceroDoc(dianType: string, idNumber: string): {
  tdoc: string;
  nid: string;
  dv: string;
} {
  // Pasaporte (41) es alfanumérico; los demás, sólo dígitos.
  const nid =
    dianType === "41" ? idNumber.replace(/[^A-Za-z0-9]/g, "") : idNumber.replace(/\D/g, "");
  return { tdoc: dianType, nid, dv: dianType === "31" ? (computeNitDv(nid) ?? "") : "" };
}

/* ───────────────────── Registros por formato (orden del anexo) ─────────── */

export type RecordData = Record<string, string | number>;

function record(element: string, order: string[], data: RecordData): string {
  const attrs: RecordData = {};
  for (const key of order) attrs[key] = data[key] ?? "";
  return el(element, attrs);
}

/** 1001 v11: pagos/abonos y retenciones practicadas. */
export function rec1001(d: RecordData): string {
  return record(
    "pagos",
    ["cpt", "tdoc", "nid", "apl1", "apl2", "nom1", "nom2", "raz", "dir", "dpto", "mun", "pais", "pago", "pnded", "ided", "inded", "retp", "reta", "comun", "ndom"],
    d,
  );
}

/** 1005 v9: IVA descontable por tercero. */
export function rec1005(d: RecordData): string {
  return record(
    "impventas",
    ["tdoc", "nid", "dv", "apl1", "apl2", "nom1", "nom2", "raz", "vimp", "ivade"],
    d,
  );
}

/** 1006 v8: IVA generado e impoconsumo por tercero. */
export function rec1006(d: RecordData): string {
  return record(
    "impoventas",
    ["tdoc", "nid", "dv", "apl1", "apl2", "nom1", "nom2", "raz", "imp", "iva", "icon"],
    d,
  );
}

/** 1007 v9: ingresos recibidos (sin DV ni dirección). */
export function rec1007(d: RecordData): string {
  return record(
    "ingresos",
    ["cpt", "tdoc", "nid", "apl1", "apl2", "nom1", "nom2", "raz", "pais", "ibru", "dred"],
    d,
  );
}

/** 1008 v7 / 1009 v7: saldos al 31-dic (mismo layout, distinto elemento). */
export function recSaldo(element: "saldoscc" | "saldoscp", d: RecordData): string {
  return record(
    element,
    ["cpt", "tdoc", "nid", "dv", "apl1", "apl2", "nom1", "nom2", "raz", "dir", "dpto", "mun", "pais", "sal"],
    d,
  );
}

/** 1010 v9: socios y accionistas. */
export function rec1010(d: RecordData): string {
  return record(
    "socios",
    ["tdoc", "nid", "dv", "apl1", "apl2", "nom1", "nom2", "raz", "dir", "dpto", "mun", "pais", "valnom", "valprm", "por", "dec"],
    d,
  );
}

/** 1011 v6: declaraciones tributarias (concepto + valor). */
export function rec1011(d: RecordData): string {
  return record("decl", ["cpt", "sal"], d);
}

/** 1012 v7: saldos de cuenta, inversiones y acciones/aportes. */
export function rec1012(d: RecordData): string {
  return record(
    "dectri",
    ["cpt", "tdoc", "nid", "dv", "apl1", "apl2", "nom1", "nom2", "raz", "pais", "val"],
    d,
  );
}

/* ─────────────── Porcentaje de participación (1010): entero × 10^dec ───── */

/** `pctBps` en basis points (1 % = 100). `por` = pct × 10^dec con dec = 5. */
export function encodePorcentajeBps(pctBps: number, dec = 5): { por: number; dec: number } {
  return { por: Math.round((pctBps / 100) * 10 ** dec), dec };
}
