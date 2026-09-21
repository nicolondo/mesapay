/**
 * Información exógena DIAN — normativa parametrizada por año gravable.
 * Port de `zenith-erp/apps/web/src/lib/exogena-normativa.ts`. Lógica pura.
 *
 * Fuentes (portal DIAN › Exógena Tributaria › Normatividad):
 *  · AG 2024: Resolución 000162 de 31-oct-2023, modificada por la 000188 de
 *    30-oct-2024 (topes y cuantías pasan a UVT) y las 000208/000213 de 2025.
 *  · AG 2025: Resolución Única 000227 de 23-sep-2025 (su Título 3 compila la
 *    162/2023 y la 188/2024), modificada por la 000233 de 30-oct-2025 (anexos
 *    técnicos), la 000012 de 29-abr-2026 y la 000021 de 17-jul-2026.
 *  · AG 2026: Resolución Única 000227/2025 + 000237 de 3-dic-2025. El 1001
 *    mantiene v11 (Res. 000233/2025, art. 29; corrección formal de la Res.
 *    000237/2025, art. 2).
 */

/* ────────────────────────────── UVT por año ──────────────────────────────
   Las cuantías de la exógena se miden con la UVT del AÑO A REPORTAR
   (aclaración de la Res. 000188/2024), no con la vigente al enviar. */

export const UVT_POR_ANO: Record<number, number> = {
  2023: 42412, // Res. 001264/2022
  2024: 47065, // Res. 000187/2023
  2025: 49799, // Res. 000193/2024
  2026: 52374, // Res. 000238/2025
};

/**
 * UVT (en PESOS) del año gravable. Si el año no está en la tabla cae al
 * fallback: `AccountingConfig.uvtCents / 100`, que el contador mantiene.
 */
export function uvtDelAno(year: number, fallbackPesos: number): number {
  return UVT_POR_ANO[year] ?? fallbackPesos;
}

/* ─────────────────────────── Cuantías mínimas ────────────────────────────
   Res. Única 000227/2025, Título 3 (reglas de la Res. 000188/2024, AG 2024+):
   · 1001: pagos acumulados por tercero < 3 UVT pueden ir agregados como
     "cuantías menores" (NIT 222222222) — SALVO los sujetos a retención en la
     fuente, que se reportan siempre con el tercero.
   · 1008/1009: saldos por tercero desde 12 UVT; los menores van agregados. */

export const CUANTIA_MENOR_PAGOS_UVT = 3;
export const CUANTIA_MENOR_SALDOS_UVT = 12;

/** Umbral en centavos de los pagos del 1001 (3 UVT). */
export function umbralPagosCents(uvtPesos: number): number {
  return CUANTIA_MENOR_PAGOS_UVT * uvtPesos * 100;
}

/** Umbral en centavos de los saldos del 1008/1009 (12 UVT). */
export function umbralSaldosCents(uvtPesos: number): number {
  return CUANTIA_MENOR_SALDOS_UVT * uvtPesos * 100;
}

/* ───────────────────────── Resoluciones por año ────────────────────────── */

export function resolucionesDelAno(year: number): string {
  if (year <= 2024) return "Resolución 000162/2023, modificada por la 000188/2024";
  if (year === 2025) {
    return "Resolución Única 000227/2025 (Título 3), mod. 000233/2025, 000012/2026 y 000021/2026";
  }
  return "Resolución Única 000227/2025 (Título 3), mod. 000237/2025";
}

/* ───────────────────────── Catálogo de formatos ────────────────────────── */

/** Formatos que MESAPAY calcula (los demás del régimen no aplican a un comercio). */
export const FORMATOS_EXOGENA = [
  "1001",
  "1005",
  "1006",
  "1007",
  "1008",
  "1009",
  "1010",
  "1011",
  "1012",
  "2276",
] as const;

export type FormatoExogena = (typeof FORMATOS_EXOGENA)[number];

export function isFormatoExogena(v: string): v is FormatoExogena {
  return (FORMATOS_EXOGENA as readonly string[]).includes(v);
}

/** Cómo produce MESAPAY cada formato. */
export type OrigenFormato =
  | "auto" // se calcula de los documentos del comercio
  | "manual" // captura manual en la pantalla
  | "mixto"; // datos del comercio, XML pendiente

export type CatalogoFormato = {
  codigo: FormatoExogena;
  /** Nombre oficial de la resolución (español; la UI lo traduce por clave). */
  nombre: string;
  version: number;
  origen: OrigenFormato;
  /** ¿Se genera el XML oficial? */
  xml: boolean;
};

/** Versión vigente de un formato en el año gravable (cambios conocidos). */
export function versionFormato(codigo: string, year: number): number {
  // Base AG 2025 (Res. Única 000227/2025 + 000233/2025).
  const v2025: Record<string, number> = {
    "1001": 11,
    "1003": 7,
    "1004": 2,
    "1005": 9,
    "1006": 8,
    "1007": 9,
    "1008": 7,
    "1009": 7,
    "1010": 9,
    "1011": 6,
    "1012": 7,
    "1647": 2,
    "2276": 4,
  };
  let v = v2025[codigo] ?? 1;
  if (year <= 2024) {
    // AG 2024 (Res. 000162/2023): 1001 aún v10 y 1005 v7.
    if (codigo === "1001") v = 10;
    if (codigo === "1005") v = 7;
  }
  if (year >= 2026 && codigo === "1647") v = 3;
  return v;
}

const NOMBRES: Record<FormatoExogena, string> = {
  "1001": "Pagos o abonos en cuenta y retenciones practicadas",
  "1005": "Impuesto sobre las ventas por pagar (descontable)",
  "1006": "Impuesto sobre las ventas por pagar (generado) e impuesto al consumo",
  "1007": "Ingresos recibidos",
  "1008": "Saldos de cuentas por cobrar al 31 de diciembre",
  "1009": "Saldos de cuentas por pagar al 31 de diciembre",
  "1010": "Información de socios, accionistas, comuneros, cooperados y/o asociados",
  "1011": "Información de declaraciones tributarias",
  "1012": "Información de declaraciones tributarias: acciones, inversiones y cuentas",
  "2276": "Información de rentas de trabajo y de pensiones",
};

const ORIGEN: Record<FormatoExogena, OrigenFormato> = {
  "1001": "auto",
  "1005": "auto",
  "1006": "auto",
  "1007": "auto",
  "1008": "auto",
  "1009": "auto",
  "1010": "manual",
  "1011": "auto",
  "1012": "manual",
  // 2276: se calcula de la nómina pero el anexo T3.45 (XML) no está portado.
  "2276": "mixto",
};

export function catalogoFormatos(year: number): CatalogoFormato[] {
  return FORMATOS_EXOGENA.map((codigo) => ({
    codigo,
    nombre: NOMBRES[codigo],
    version: versionFormato(codigo, year),
    origen: ORIGEN[codigo],
    xml: codigo !== "2276",
  }));
}

/* ─────────────────────── Conceptos del formato 1001 ──────────────────────
   Catálogo de la Res. Única 000227/2025 (T3, formato 1001 v11). Sólo los
   que un restaurante usa; el resto (aportes parafiscales, etc.) no aplica
   porque los pagos laborales van en el 2276. */

export const CONCEPTOS_1001 = {
  SALARIOS: "5001",
  HONORARIOS: "5002",
  COMISIONES: "5003",
  SERVICIOS: "5004",
  ARRENDAMIENTOS: "5005",
  INTERESES: "5006",
  ACTIVOS_FIJOS: "5007",
  OTROS: "5016",
} as const;

export type Concepto1001 = (typeof CONCEPTOS_1001)[keyof typeof CONCEPTOS_1001];

/**
 * Concepto 1001 de un GASTO manual a partir de su categoría (texto libre).
 * Misma heurística por palabras clave que `expenseAccountFor` en
 * `posting.ts` (que clasifica la cuenta del PUC), llevada al concepto DIAN:
 *   arriendo → 5005 · honorarios/contador/asesoría → 5002 · comisiones/
 *   pasarela/datáfono → 5003 · telecomunicaciones, servicios públicos,
 *   mantenimiento, publicidad → 5004 (servicios) · intereses → 5006 ·
 *   nómina/salarios → 5001 · el resto → 5016.
 * Los pagos por nómina liquidada (PayrollRun) NO pasan por acá: van al 2276.
 */
export function concepto1001DeCategoria(category: string): Concepto1001 {
  const c = category.toLowerCase();
  if (/(arriend|alquil|\blocal\b|renta)/.test(c)) return CONCEPTOS_1001.ARRENDAMIENTOS;
  if (/(honorar|contad|asesor|jur[ií]dic)/.test(c)) return CONCEPTOS_1001.HONORARIOS;
  if (/(comis|pasarela|tarjeta|dat[aá]fono)/.test(c)) return CONCEPTOS_1001.COMISIONES;
  if (/(inter[eé]s|financier|banc)/.test(c)) return CONCEPTOS_1001.INTERESES;
  if (/(internet|tel[eé]fon|datos|celular|plan)/.test(c)) return CONCEPTOS_1001.SERVICIOS;
  if (/(servici|agua|luz|energ|\bgas\b|acueduct|p[uú]blic)/.test(c)) return CONCEPTOS_1001.SERVICIOS;
  if (/(manteni|reparac|arreglo)/.test(c)) return CONCEPTOS_1001.SERVICIOS;
  if (/(public|marketing|redes|pauta|volante)/.test(c)) return CONCEPTOS_1001.SERVICIOS;
  if (/(n[oó]mina|salari|sueld|personal)/.test(c)) return CONCEPTOS_1001.SALARIOS;
  return CONCEPTOS_1001.OTROS;
}

/**
 * Concepto 1001 de las COMPRAS (órdenes de compra recibidas). MESAPAY no
 * tiene `Supplier.exogenaConcept`; por defecto las compras de insumos y
 * mercancía se reportan en 5016 "los demás costos y deducciones" (5004 es
 * "servicios" en el catálogo oficial, no compras). Si algún día se agrega
 * la columna al proveedor, este es el único punto que cambia.
 */
export const CONCEPTO_1001_COMPRAS: Concepto1001 = CONCEPTOS_1001.OTROS;

/* ─────────────────────── Conceptos del formato 1007 ────────────────────── */

/** Ingresos brutos operacionales (ventas del comercio). */
export const CONCEPTO_1007_OPERACIONALES = "4001";

/* ───────────────────── Conceptos del formato 1008/1009 ─────────────────── */

/** 1008: clientes (cuenta 1305/1315 del PUC → concepto oficial 1315). */
export const CONCEPTO_1008_CLIENTES = "1315";
/** 1009: proveedores (cuenta 2205 → concepto oficial 2201). */
export const CONCEPTO_1009_PROVEEDORES = "2201";

/* ─────────────────────── Conceptos del formato 1011 ──────────────────────
   El formato 1011 v6 (Res. Única 000227/2025, T3) reporta VALORES DE LAS
   DECLARACIONES de renta e IVA por concepto de 4 dígitos (ingresos no
   constitutivos 8xxx, rentas exentas 81xx, costos y deducciones 82xx,
   descuentos 83xx…). De lo que MESAPAY registra en `TaxFiling` (IVA, INC,
   retefuente e ICA declarados y pagados) sólo el ICA pagado tiene un
   concepto natural: la deducción por impuestos pagados del art. 115 ET.
   Los otros tres formularios se muestran en pantalla con su total del año
   pero NO van al XML (una retención declarada no es un valor del 1011).
   Los códigos son el DEFAULT de MESAPAY: el contador los valida contra el
   anexo técnico en el prevalidador antes de presentar. */

export const CONCEPTO_1011_POR_FORMULARIO: Record<string, string | null> = {
  ica: "8214",
  iva: null,
  inc: null,
  retefuente: null,
};

/* ─────────────────────── Conceptos del formato 1012 ────────────────────── */

// Formato 1012 v7 (Res. Única 000227/2025, T3): saldos y valores
// patrimoniales al 31/12. La captura manual no pide país: todo sale con país
// 169 (Colombia); para 1115/1206 el contador ajusta el país en el prevalidador.
export const CONCEPTOS_1012 = [
  "1110", // cuentas corrientes y/o de ahorro en el país
  "1115", // cuentas corrientes y/o de ahorro en el exterior
  "1200", // inversiones en bonos
  "1201", // certificados a término (CDT)
  "1202", // títulos
  "1203", // derechos fiduciarios
  "1204", // inversiones en fondos
  "1205", // acciones y aportes en sociedades nacionales
  "1206", // acciones y aportes en sociedades del exterior
] as const;

export type Concepto1012 = (typeof CONCEPTOS_1012)[number];

export function isConcepto1012(v: string): v is Concepto1012 {
  return (CONCEPTOS_1012 as readonly string[]).includes(v);
}

/* ─────────────────────── Documentos de los terceros ─────────────────────── */

/** Tipos de documento del sistema que aceptan las capturas manuales. */
export const DOC_TYPES_MANUALES = ["NIT", "CC", "CE", "PA"] as const;
export type DocTypeManual = (typeof DOC_TYPES_MANUALES)[number];

/* ───────────────────────────── Año gravable ────────────────────────────── */

/**
 * Año gravable de la URL (`?year=`): cuatro dígitos entre 2020 y 2100.
 * Vacío/ausente ⇒ el año anterior al actual (la exógena se presenta en
 * mayo-junio por el año que cerró). Inválido ⇒ null.
 */
export function parseAnoGravable(
  raw: string | null | undefined,
  now: Date = new Date(),
): number | null {
  if (raw === null || raw === undefined || raw === "") return now.getUTCFullYear() - 1;
  if (!/^\d{4}$/.test(raw)) return null;
  const y = Number(raw);
  return y >= 2020 && y <= 2100 ? y : null;
}
