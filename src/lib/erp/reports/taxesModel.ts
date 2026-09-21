/**
 * IMPUESTOS DEL PERÍODO — familias de cuentas tributarias (modelo puro).
 * Portado de zenith `reportes/impuestos/impuestos-cuentas-model.ts`.
 *
 * El IVA/INC del reporte sale de los DOCUMENTOS (facturas y compras, por
 * tarifa: ver `taxesDocuments.ts`), pero las RETENCIONES y los DEMÁS
 * impuestos del período no viven en líneas de documento: viven en el LIBRO,
 * en cuentas conocidas del PUC. Este modelo clasifica cuentas por PREFIJO
 * de código y agrega su movimiento del período con el signo de su
 * naturaleza:
 *
 *   · 1355   ANTICIPO DE IMPUESTOS (activo, a favor — entra al débito):
 *            135515 retefuente que NOS practican, 135517 reteIVA,
 *            135518 reteICA, resto = otros anticipos (renta, ICA…).
 *   · 2365   RETENCIÓN EN LA FUENTE practicada (pasivo — entra al crédito).
 *   · 2367   IVA RETENIDO practicado (reteIVA, pasivo).
 *   · 2368   ICA RETENIDO practicado (reteICA, pasivo).
 *   · 24     IMPUESTOS, GRAVÁMENES Y TASAS por pagar — el grupo COMPLETO del
 *            PUC, no una lista cerrada: 2404 renta, 2408 IVA, y cualquier
 *            otro (predial, otros…). Lo que tenga movimiento sale.
 *
 * ── Desviación respecto a zenith: INC e ICA ─────────────────────────────
 * En el PUC estándar 2412 es "industria y comercio" (ICA) y el impoconsumo
 * no tiene subcuenta canónica. El PUC que MESAPAY siembra (`pucNiif.ts`) y
 * contra el que escribe el motor (`engineCodes.ts`) es distinto: el INC
 * generado va a `ENGINE.INC_GENERADO` (241205, cuenta 2412 «Impuesto
 * nacional al consumo») y el ICA a `ENGINE.ICA_POR_PAGAR` (241605, cuenta
 * 2416). Las familias `consumo` e `ica` se derivan de esos códigos del
 * motor —no de la convención de zenith— para que el reporte diga lo mismo
 * que el libro que el propio motor escribe.
 *
 * AGRUPAR POR PREFIJO es deliberado: el árbol del IVA tiene auxiliares de
 * 8 dígitos bajo la madre de 6 (2408 → 240805 → 24080501…), así que la
 * madre y las auxiliares ruedan a la MISMA familia. El prefijo MÁS LARGO
 * gana (135515 antes que 1355; 2408 antes que 24).
 *
 * Además del prefijo, las cuentas apuntadas por los CONCEPTOS DE RETENCIÓN
 * del comercio (`RetentionConcept.accountCode`) se asignan a la familia de
 * su `kind` (retefuente / reteiva / reteica), estén en el código que estén.
 * Una cuenta que llega por concepto y no calza en ningún prefijo ni tiene
 * kind conocido se clasifica por su NATURALEZA (activo → a favor, pasivo →
 * por pagar).
 */
import { ENGINE } from "../engineCodes";
import { pucParentCode } from "../pucNiif";

export type TaxAccount = {
  code: string;
  name: string;
  /** Clase contable (`LedgerAccount.type`): activo | pasivo | patrimonio | ingreso | gasto | costo. */
  type: string;
};

export type Movement = { debitCents: number; creditCents: number };

/** Línea del libro tal como la entrega la capa de consultas (o ya agregada por cuenta). */
export type TaxLedgerLine = {
  accountCode: string;
  debitCents: number;
  creditCents: number;
};

export type FamilyKey =
  | "retefuente-favor"
  | "reteiva-favor"
  | "reteica-favor"
  | "anticipos"
  | "otras-favor"
  | "retefuente"
  | "reteiva"
  | "reteica"
  | "iva"
  | "consumo"
  | "ica"
  | "renta"
  | "otros-impuestos"
  | "otras-pagar";

/** Cuenta (4 dígitos) de un código del motor: 241205 → 2412. */
function accountOfEngineCode(code: string): string {
  return code.length > 4 ? (pucParentCode(code) ?? code).slice(0, 4) : code;
}

/**
 * Familias con su prefijo del PUC. El ORDEN es el de lectura; la
 * clasificación no depende de él (gana el prefijo más largo).
 */
export const TAX_ACCOUNT_FAMILIES: readonly { key: FamilyKey; prefix: string }[] = [
  { key: "retefuente-favor", prefix: "135515" },
  { key: "reteiva-favor", prefix: "135517" },
  { key: "reteica-favor", prefix: "135518" },
  { key: "anticipos", prefix: "1355" },
  { key: "retefuente", prefix: "2365" },
  { key: "reteiva", prefix: "2367" },
  { key: "reteica", prefix: "2368" },
  { key: "renta", prefix: "2404" },
  { key: "iva", prefix: "2408" },
  { key: "consumo", prefix: accountOfEngineCode(ENGINE.INC_GENERADO) },
  { key: "ica", prefix: accountOfEngineCode(ENGINE.ICA_POR_PAGAR) },
  { key: "otros-impuestos", prefix: "24" },
];

/**
 * Prefijos "raíz" para traer cuentas/líneas de la base: se descartan los
 * que ya quedan contenidos en otro (135515 vive dentro de 1355; 2408
 * dentro de 24).
 */
export const TAX_ACCOUNT_PREFIXES: readonly string[] = TAX_ACCOUNT_FAMILIES.map(
  (f) => f.prefix,
).filter((p, _i, all) => !all.some((q) => q !== p && p.startsWith(q)));

/** Familias de RETENCIÓN (las que el detalle lista comprobante por comprobante). */
export const RETENTION_FAMILIES: readonly FamilyKey[] = [
  "retefuente",
  "reteiva",
  "reteica",
  "retefuente-favor",
  "reteiva-favor",
  "reteica-favor",
];

/** Prefijos raíz de las cuentas de retención (para el detalle). */
export const RETENTION_PREFIXES: readonly string[] = TAX_ACCOUNT_FAMILIES.filter((f) =>
  RETENTION_FAMILIES.includes(f.key),
).map((f) => f.prefix);

/** ¿Naturaleza crédito? pasivo/patrimonio/ingreso crecen al crédito. */
export function isCreditNature(type: string): boolean {
  return type === "pasivo" || type === "patrimonio" || type === "ingreso";
}

/** `RetentionConcept.kind` → familia (por pagar o a favor según la naturaleza). */
function familyOfConceptKind(kind: string, type: string): FamilyKey | null {
  if (kind !== "retefuente" && kind !== "reteiva" && kind !== "reteica") return null;
  return isCreditNature(type) ? kind : (`${kind}-favor` as FamilyKey);
}

/**
 * Familia de una cuenta: primero el `kind` del concepto de retención que
 * la apunta, luego el prefijo del PUC MÁS LARGO que calce, y si nada
 * calza, por naturaleza.
 */
export function classifyTaxAccount(
  code: string,
  type: string,
  conceptKind?: string | null,
): FamilyKey {
  if (conceptKind) {
    const byKind = familyOfConceptKind(conceptKind, type);
    if (byKind) return byKind;
  }
  let best: { key: FamilyKey; prefix: string } | null = null;
  for (const f of TAX_ACCOUNT_FAMILIES) {
    if (code.startsWith(f.prefix) && (!best || f.prefix.length > best.prefix.length)) best = f;
  }
  if (best) return best.key;
  return isCreditNature(type) ? "otras-pagar" : "otras-favor";
}

/**
 * Movimiento del período con el signo de la naturaleza de la cuenta:
 * pasivo/patrimonio/ingreso crecen al crédito; activo/gasto/costo al
 * débito. Así un impuesto por pagar y una retención a favor salen ambos
 * POSITIVOS cuando crecen, y negativos si el período neto los revierte
 * (anulaciones, devoluciones, pagos de la declaración anterior).
 */
export function signedMovement(type: string, mov: Movement): number {
  return isCreditNature(type)
    ? mov.creditCents - mov.debitCents
    : mov.debitCents - mov.creditCents;
}

export type FamilyRows = {
  key: FamilyKey;
  rows: { code: string; name: string; valorCents: number }[];
  subtotalCents: number;
};

export type TaxAccountGroupKey = "pagar" | "favor";

export type TaxAccountGroup = {
  key: TaxAccountGroupKey;
  families: FamilyRows[];
  totalCents: number;
};

export type TaxAccountReport = {
  groups: TaxAccountGroup[];
  /** Activos: retenciones que nos practicaron y anticipos (1355 + otras a favor). */
  totalAFavorCents: number;
  /** Pasivos: impuestos y retenciones por declarar y pagar. */
  totalPorPagarCents: number;
};

/** Los grupos son la NATURALEZA; dentro, las familias en orden de lectura. */
export const TAX_GROUP_DEFS: readonly { key: TaxAccountGroupKey; families: readonly FamilyKey[] }[] = [
  {
    key: "pagar",
    families: [
      "iva",
      "consumo",
      "ica",
      "renta",
      "otros-impuestos",
      "retefuente",
      "reteiva",
      "reteica",
      "otras-pagar",
    ],
  },
  {
    key: "favor",
    families: ["retefuente-favor", "reteiva-favor", "reteica-favor", "anticipos", "otras-favor"],
  },
];

/** Σ débitos/créditos por cuenta. */
export function aggregateMovements(lines: readonly TaxLedgerLine[]): Map<string, Movement> {
  const out = new Map<string, Movement>();
  for (const l of lines) {
    const prev = out.get(l.accountCode) ?? { debitCents: 0, creditCents: 0 };
    prev.debitCents += l.debitCents;
    prev.creditCents += l.creditCents;
    out.set(l.accountCode, prev);
  }
  return out;
}

/**
 * Arma el reporte: líneas del libro + plan de cuentas → familias con
 * filas por cuenta (solo movimiento ≠ 0) agrupadas por naturaleza, con
 * subtotales. `conceptKindByCode` mapea cuenta → `kind` del concepto de
 * retención que la apunta. Una línea sobre una cuenta que no está en el
 * plan se clasifica igual por código, con nombre vacío y naturaleza
 * deducida de la clase (2 → pasivo, resto → activo): nunca se pierde plata.
 */
export function buildTaxAccountReport(
  lines: readonly TaxLedgerLine[],
  accounts: readonly TaxAccount[],
  opts: { conceptKindByCode?: ReadonlyMap<string, string> } = {},
): TaxAccountReport {
  const byCode = new Map<string, TaxAccount>();
  for (const a of accounts) byCode.set(a.code, a);
  const movements = aggregateMovements(lines);

  const byFamily = new Map<FamilyKey, FamilyRows["rows"]>();
  for (const [code, mov] of movements) {
    const account = byCode.get(code) ?? {
      code,
      name: "",
      type: code.startsWith("2") ? "pasivo" : "activo",
    };
    const valorCents = signedMovement(account.type, mov);
    if (valorCents === 0) continue;
    const fam = classifyTaxAccount(code, account.type, opts.conceptKindByCode?.get(code));
    const list = byFamily.get(fam) ?? [];
    list.push({ code, name: account.name, valorCents });
    byFamily.set(fam, list);
  }

  const groups: TaxAccountGroup[] = TAX_GROUP_DEFS.map((g) => {
    const families: FamilyRows[] = g.families
      .map((key) => {
        const rows = (byFamily.get(key) ?? []).sort((a, b) => a.code.localeCompare(b.code));
        return { key, rows, subtotalCents: rows.reduce((s, r) => s + r.valorCents, 0) };
      })
      .filter((f) => f.rows.length > 0);
    return {
      key: g.key,
      families,
      totalCents: families.reduce((s, f) => s + f.subtotalCents, 0),
    };
  }).filter((g) => g.families.length > 0);

  const totalOf = (key: TaxAccountGroupKey) =>
    groups.find((g) => g.key === key)?.totalCents ?? 0;
  return { groups, totalAFavorCents: totalOf("favor"), totalPorPagarCents: totalOf("pagar") };
}

/** Subtotal de una familia en el reporte (0 si no tiene movimiento). */
export function familySubtotal(report: TaxAccountReport, key: FamilyKey): number {
  for (const g of report.groups) {
    const f = g.families.find((x) => x.key === key);
    if (f) return f.subtotalCents;
  }
  return 0;
}
