/**
 * Información exógena — AGREGACIÓN por tercero y formato. Lógica PURA
 * (sin DB): recibe filas planas que carga `queries.ts` y devuelve las
 * tablas de cada formato + el panel de incidencias. Todo en CENTAVOS; la
 * conversión a pesos enteros la hace `download.ts` al armar el XML.
 *
 * Terceros de MESAPAY:
 *  · Proveedor (`Supplier`): sólo `taxId` libre, sin tipo de documento ni
 *    naturaleza. Se infiere (ver `supplierTercero`).
 *  · Adquiriente: la solicitud de factura (`InvoiceRequest`) de la orden
 *    facturada (docType + docNumber) o el `BillingCustomer` de los bonos.
 *    Las facturas sin solicitud son "consumidor final" (222222222222 / 43).
 *  · Empleado (`Employee`): NO tiene documento; el 2276 se calcula por
 *    empleado y se marca la incidencia (sin XML, como en zenith).
 */

import { computeNitDv, isValidNitDv } from "../exogena";
import {
  CONCEPTO_1001_COMPRAS,
  CONCEPTO_1007_OPERACIONALES,
  CONCEPTO_1011_POR_FORMULARIO,
  concepto1001DeCategoria,
  type FormatoExogena,
} from "./normativa";
import { resolveCustomerMunicipio } from "@/lib/dian/emit";
import { CONSUMIDOR_FINAL_NID, CONSUMIDOR_FINAL_RAZ, dianIdType, PAIS_COLOMBIA } from "./xml";

/* ─────────────────────────────── Terceros ─────────────────────────────── */

export type Tercero = {
  /** Clave de agrupación estable (id del proveedor/cliente, o "cf"). */
  key: string;
  name: string;
  /** Tipo de documento del sistema (NIT | CC | CE | PA…) o null si no se sabe. */
  docType: string | null;
  /** Número tal como está guardado (puede traer puntos o guión-DV). */
  docNumber: string | null;
  /** DV escrito por el usuario, si lo hay (se valida, no se usa en el XML). */
  dvGiven: string | null;
  kind: "natural" | "juridica";
  dir: string;
  /** Departamento DANE (2 dígitos) o "0" si no se conoce. */
  dpto: string;
  /** Municipio DANE (3 dígitos) o "0" si no se conoce. */
  mun: string;
  pais: string;
  /** Enlace de la UI para corregir el tercero (proveedor / cliente). */
  href: string | null;
};

export type TerceroDoc = { tdoc: string; nid: string; dv: string };

export type IssueCode =
  | "missing_doc"
  | "doc_not_numeric"
  | "missing_doc_type"
  | "invalid_dv"
  | "missing_concept"
  | "employee_missing_doc";

export type ExogenaIssue = {
  format: FormatoExogena;
  code: IssueCode;
  /** Tercero afectado. */
  name: string;
  amountCents: number;
  href: string | null;
  /** Bloquea la descarga del XML del formato. */
  blocking: boolean;
};

/** Sólo dígitos (o alfanumérico para pasaporte). */
function cleanNid(tdoc: string, raw: string): string {
  return tdoc === "41" ? raw.replace(/[^A-Za-z0-9]/g, "") : raw.replace(/\D/g, "");
}

/**
 * Documento DIAN de un tercero. `doc` null ⇒ no se puede reportar (la
 * incidencia dice por qué). `warning` = DV escrito distinto del calculado:
 * NO bloquea (el XML lleva el DV calculado) pero se muestra para corregir.
 */
export function resolveTerceroDoc(t: Tercero): {
  doc: TerceroDoc | null;
  issue: IssueCode | null;
  warning: IssueCode | null;
} {
  const raw = (t.docNumber ?? "").trim();
  if (!raw) return { doc: null, issue: "missing_doc", warning: null };
  const tdoc = dianIdType(t.docType);
  if (!tdoc) return { doc: null, issue: "missing_doc_type", warning: null };
  // La exógena exige nid numérico (salvo pasaporte). Un número con letras no
  // se limpia a ciegas: se omite y sale en el panel de incidencias.
  const base = tdoc === "31" && raw.includes("-") ? raw.split("-")[0]! : raw;
  const compact = base.replace(/[\s.]/g, "");
  if (tdoc === "41" ? !/^[A-Za-z0-9]+$/.test(compact) : !/^\d+$/.test(compact)) {
    return { doc: null, issue: "doc_not_numeric", warning: null };
  }
  const nid = cleanNid(tdoc, compact);
  const dv = tdoc === "31" ? (computeNitDv(nid) ?? "") : "";
  const warning =
    tdoc === "31" && t.dvGiven && !isValidNitDv(nid, t.dvGiven) ? "invalid_dv" : null;
  return { doc: { tdoc, nid, dv }, issue: null, warning };
}

/* ───────────────────────────── Proveedores ────────────────────────────── */

export type SupplierInput = {
  id: string;
  name: string;
  taxId: string | null;
  address: string | null;
};

/**
 * Tercero de un proveedor. `Supplier.taxId` es texto libre ("900123456-7",
 * "1.020.304.050", "NIT 800..."), sin tipo ni naturaleza, así que:
 *  · "-X" al final = DV escrito (se valida contra el módulo 11);
 *  · 9 dígitos que empiezan por 8 o 9 ⇒ NIT de persona jurídica (31, raz);
 *  · con DV escrito ⇒ NIT (31) aunque sea de persona natural;
 *  · lo demás ⇒ cédula (13) de persona natural (apl/nom).
 * Sin dirección estructurada: dir = `address`, dpto/mun = "0" (el contador
 * los completa en el prevalidador), país = Colombia.
 */
export function supplierTercero(s: SupplierInput): Tercero {
  const raw = (s.taxId ?? "").trim().replace(/^nit\.?\s*/i, "");
  let base = raw;
  let dvGiven: string | null = null;
  const m = /^(.*\d)\s*-\s*(\d)$/.exec(raw);
  if (m) {
    base = m[1]!;
    dvGiven = m[2]!;
  }
  const digits = base.replace(/\D/g, "");
  const juridica = digits.length === 9 && /^[89]/.test(digits);
  const docType = !raw ? null : juridica || dvGiven ? "NIT" : "CC";
  return {
    key: `sup:${s.id}`,
    name: s.name.trim(),
    docType,
    docNumber: raw ? base.trim() : null,
    dvGiven,
    kind: juridica ? "juridica" : "natural",
    dir: (s.address ?? "").trim(),
    dpto: "0",
    mun: "0",
    pais: PAIS_COLOMBIA,
    href: "/operator/settings/proveedores",
  };
}

/** El adquiriente genérico de las ventas sin solicitud de factura. */
export function consumidorFinalTercero(): Tercero {
  return {
    key: "cf",
    name: CONSUMIDOR_FINAL_RAZ,
    docType: "DEX",
    docNumber: CONSUMIDOR_FINAL_NID,
    dvGiven: null,
    kind: "juridica",
    dir: "",
    dpto: "0",
    mun: "0",
    pais: PAIS_COLOMBIA,
    href: null,
  };
}

/* ────────────────────── Adquirientes (ventas y bonos) ─────────────────── */

/** dpto/mun a partir de un código DANE de 5 dígitos ("05001" → "05" / "001"). */
export function daneParts(code: string | null | undefined): { dpto: string; mun: string } {
  const c = (code ?? "").replace(/\D/g, "");
  if (c.length !== 5) return { dpto: "0", mun: "0" };
  return { dpto: c.slice(0, 2), mun: c.slice(2) };
}

export type InvoiceRequestTerceroInput = {
  customerName: string;
  docType: string;
  docNumber: string;
  /**
   * Opcionales: la solicitud de factura ya no pide dirección, ciudad ni
   * departamento; sólo las filas viejas los traen.
   */
  address?: string | null;
  city?: string | null;
  department?: string | null;
};

/**
 * Adquiriente de una tirilla: la solicitud de factura de su orden. Sin
 * dirección —lo normal desde que no se pide— va como un proveedor sin datos
 * fiscales: dir vacía, dpto/mun "0" (el contador los completa en el
 * prevalidador) y país Colombia. Con dirección, el municipio DANE se
 * resuelve del texto libre como en la factura electrónica.
 */
export function requestTercero(r: InvoiceRequestTerceroInput): Tercero {
  const digits = r.docNumber.replace(/\D/g, "");
  const municipio = resolveCustomerMunicipio(r.city, r.department);
  return {
    key: `cli:${r.docType}:${digits || r.docNumber.trim()}`,
    name: r.customerName.trim(),
    docType: r.docType,
    docNumber: r.docNumber,
    dvGiven: null,
    kind: r.docType === "NIT" ? "juridica" : "natural",
    dir: (r.address ?? "").trim(),
    ...(municipio ? { dpto: municipio.deptCode, mun: municipio.code.slice(2) } : { dpto: "0", mun: "0" }),
    pais: PAIS_COLOMBIA,
    href: "/operator/facturas",
  };
}

export type BillingCustomerTerceroInput = {
  id: string;
  customerName: string;
  docType: string;
  docNumber: string;
  verificationDigit: string | null;
  /** null desde que el alta de clientes no pide dirección ni municipio. */
  address: string | null;
  municipalityCode: string | null;
  country: string;
};

/**
 * Cliente de facturación (bonos): documento estructurado + DANE. Sin
 * municipio ⇒ dpto/mun "0"; sin dirección ⇒ dir vacía; el país sale de
 * `country` (Colombia por defecto).
 */
export function billingCustomerTercero(c: BillingCustomerTerceroInput): Tercero {
  return {
    key: `bc:${c.id}`,
    name: c.customerName.trim(),
    docType: c.docType,
    docNumber: c.docNumber,
    dvGiven: c.verificationDigit?.trim() || null,
    kind: c.docType === "NIT" ? "juridica" : "natural",
    dir: (c.address ?? "").trim(),
    ...daneParts(c.municipalityCode),
    pais: c.country.trim().toUpperCase() === "CO" ? PAIS_COLOMBIA : "0",
    href: "/operator/clientes",
  };
}

/* ─────────────────────────── Filas de entrada ─────────────────────────── */

export type PurchaseInput = {
  supplier: SupplierInput;
  /** Neto recibido (sin IVA). */
  netCents: number;
  /** IVA de las líneas (taxPct × neto). */
  ivaCents: number;
  /** Parte del IVA que NO es descontable (líneas no inventario marcadas así). */
  indedCents: number;
  retefuenteCents: number;
  reteIvaCents: number;
};

export type ExpenseInput = {
  supplier: SupplierInput;
  category: string;
  amountCents: number;
};

export type SaleInput = {
  /** null ⇒ consumidor final. */
  customer: Tercero | null;
  /** Base gravable (ingreso sin impuesto ni propina). */
  baseCents: number;
  ivaCents: number;
  incCents: number;
};

export type ReceivableInput = { customer: Tercero; saldoCents: number };

export type PayableInput = {
  supplier: SupplierInput;
  /** Total bruto del documento (OC: neto + IVA; gasto: su valor). */
  totalCents: number;
  /** Abonos con fecha ≤ 31/12 del año. */
  paidCents: number;
};

export type FilingInput = { form: string; declaredCents: number };

export type PayrollItemInput = {
  employeeId: string;
  employeeName: string;
  conceptKey: string;
  kind: string;
  amountCents: number;
};

export type ShareholderInput = {
  id: string;
  name: string;
  docType: string;
  docNumber: string;
  dv: string | null;
  sharePctBps: number;
  nominalCents: number;
  premiumCents: number;
};

export type HoldingInput = {
  id: string;
  concept: string;
  entityName: string;
  entityDocType: string;
  entityDocNumber: string;
  valueCents: number;
};

/* ─────────────────────────── Filas de salida ──────────────────────────── */

export type Row1001 = {
  tercero: Tercero;
  concept: string;
  pagoCents: number;
  idedCents: number;
  indedCents: number;
  retpCents: number;
  retaCents: number;
};
export type Row1005 = { tercero: Tercero; vimpCents: number; ivadeCents: number };
export type Row1006 = { tercero: Tercero; ivaCents: number; ivaDevCents: number; incCents: number };
export type Row1007 = { tercero: Tercero; concept: string; ibruCents: number; dredCents: number };
export type RowSaldo = { tercero: Tercero; saldoCents: number };
export type Row1010 = {
  id: string;
  tercero: Tercero;
  sharePctBps: number;
  nominalCents: number;
  premiumCents: number;
};
export type Row1011 = { form: string; concept: string | null; valueCents: number; count: number };
export type Row1012 = { id: string; concept: string; tercero: Tercero; valueCents: number };
export type Row2276 = {
  employeeId: string;
  name: string;
  salarioCents: number;
  otrosCents: number;
  saludCents: number;
  pensionCents: number;
  retefuenteCents: number;
};

const byTotalDesc =
  <T>(total: (r: T) => number) =>
  (a: T, b: T) =>
    total(b) - total(a);

/* ──────────────────────────────── 1001 ────────────────────────────────── */

/**
 * Pagos o abonos en cuenta por tercero y concepto:
 *  · compras recibidas: pago = neto (el IVA va aparte en ided/inded),
 *    retp = retefuente practicada, reta = reteIVA; concepto 5016;
 *  · gastos manuales con proveedor: pago = valor, concepto por categoría.
 * La nómina liquidada NO entra: va al 2276.
 */
export function aggregate1001(i: { purchases: PurchaseInput[]; expenses: ExpenseInput[] }): Row1001[] {
  const rows = new Map<string, Row1001>();
  const bump = (
    tercero: Tercero,
    concept: string,
    d: { pago: number; ided: number; inded: number; retp: number; reta: number },
  ) => {
    const k = `${tercero.key}:${concept}`;
    const cur = rows.get(k) ?? {
      tercero,
      concept,
      pagoCents: 0,
      idedCents: 0,
      indedCents: 0,
      retpCents: 0,
      retaCents: 0,
    };
    cur.pagoCents += d.pago;
    cur.idedCents += d.ided;
    cur.indedCents += d.inded;
    cur.retpCents += d.retp;
    cur.retaCents += d.reta;
    rows.set(k, cur);
  };
  for (const p of i.purchases) {
    const inded = Math.max(0, Math.min(p.ivaCents, p.indedCents));
    bump(supplierTercero(p.supplier), CONCEPTO_1001_COMPRAS, {
      pago: p.netCents,
      ided: p.ivaCents - inded,
      inded,
      retp: p.retefuenteCents,
      reta: p.reteIvaCents,
    });
  }
  for (const e of i.expenses) {
    bump(supplierTercero(e.supplier), concepto1001DeCategoria(e.category), {
      pago: e.amountCents,
      ided: 0,
      inded: 0,
      retp: 0,
      reta: 0,
    });
  }
  return [...rows.values()]
    .filter((r) => r.pagoCents > 0 || r.retpCents > 0 || r.retaCents > 0)
    .sort(byTotalDesc((r) => r.pagoCents));
}

/* ──────────────────────────────── 1005 ────────────────────────────────── */

/** IVA descontable por proveedor (Σ IVA de las compras con taxPct > 0). */
export function aggregate1005(purchases: PurchaseInput[]): Row1005[] {
  const rows = new Map<string, Row1005>();
  for (const p of purchases) {
    const deductible = p.ivaCents - Math.max(0, Math.min(p.ivaCents, p.indedCents));
    if (deductible <= 0) continue;
    const tercero = supplierTercero(p.supplier);
    const cur = rows.get(tercero.key) ?? { tercero, vimpCents: 0, ivadeCents: 0 };
    cur.vimpCents += deductible;
    rows.set(tercero.key, cur);
  }
  return [...rows.values()].sort(byTotalDesc((r) => r.vimpCents));
}

/* ──────────────────────────────── 1006 ────────────────────────────────── */

/** IVA generado e INC por adquiriente; las ventas sin solicitud, en consumidor final. */
export function aggregate1006(sales: SaleInput[]): Row1006[] {
  const rows = new Map<string, Row1006>();
  for (const s of sales) {
    if (s.ivaCents <= 0 && s.incCents <= 0) continue;
    const tercero = s.customer ?? consumidorFinalTercero();
    const cur = rows.get(tercero.key) ?? { tercero, ivaCents: 0, ivaDevCents: 0, incCents: 0 };
    cur.ivaCents += s.ivaCents;
    cur.incCents += s.incCents;
    rows.set(tercero.key, cur);
  }
  return [...rows.values()].sort(byTotalDesc((r) => r.ivaCents + r.incCents));
}

/* ──────────────────────────────── 1007 ────────────────────────────────── */

/** Ingresos brutos (sin impuesto ni propina) por adquiriente, concepto 4001. */
export function aggregate1007(sales: SaleInput[]): Row1007[] {
  const rows = new Map<string, Row1007>();
  for (const s of sales) {
    if (s.baseCents <= 0) continue;
    const tercero = s.customer ?? consumidorFinalTercero();
    const cur = rows.get(tercero.key) ?? {
      tercero,
      concept: CONCEPTO_1007_OPERACIONALES,
      ibruCents: 0,
      dredCents: 0,
    };
    cur.ibruCents += s.baseCents;
    rows.set(tercero.key, cur);
  }
  return [...rows.values()].sort(byTotalDesc((r) => r.ibruCents));
}

/* ───────────────────────────── 1008 / 1009 ────────────────────────────── */

/** Saldos CxC al 31/12 por cliente (cortes de bonos a crédito abiertos). */
export function aggregate1008(receivables: ReceivableInput[]): RowSaldo[] {
  const rows = new Map<string, RowSaldo>();
  for (const r of receivables) {
    if (r.saldoCents <= 0) continue;
    const cur = rows.get(r.customer.key) ?? { tercero: r.customer, saldoCents: 0 };
    cur.saldoCents += r.saldoCents;
    rows.set(r.customer.key, cur);
  }
  return [...rows.values()].sort(byTotalDesc((r) => r.saldoCents));
}

/**
 * Saldos CxP al 31/12 por proveedor: total bruto − abonos con fecha ≤ 31/12
 * (misma fórmula que la CxP de compras: `poTotals(...).totalCents − paidCents`,
 * pero cortada a la fecha, porque `paidCents` acumula abonos posteriores).
 */
export function aggregate1009(payables: PayableInput[]): RowSaldo[] {
  const rows = new Map<string, RowSaldo>();
  for (const p of payables) {
    const saldo = p.totalCents - p.paidCents;
    if (saldo <= 0) continue;
    const tercero = supplierTercero(p.supplier);
    const cur = rows.get(tercero.key) ?? { tercero, saldoCents: 0 };
    cur.saldoCents += saldo;
    rows.set(tercero.key, cur);
  }
  return [...rows.values()].sort(byTotalDesc((r) => r.saldoCents));
}

/* ──────────────────────────────── 1010 ────────────────────────────────── */

function manualTercero(
  key: string,
  name: string,
  docType: string,
  docNumber: string,
  dv: string | null,
): Tercero {
  return {
    key,
    name: name.trim(),
    docType,
    docNumber: docNumber.trim(),
    dvGiven: dv,
    kind: docType.toUpperCase() === "NIT" ? "juridica" : "natural",
    dir: "",
    dpto: "0",
    mun: "0",
    pais: PAIS_COLOMBIA,
    href: null,
  };
}

export function rows1010(shareholders: ShareholderInput[]): Row1010[] {
  return shareholders.map((s) => ({
    id: s.id,
    tercero: manualTercero(`sh:${s.id}`, s.name, s.docType, s.docNumber, s.dv),
    sharePctBps: s.sharePctBps,
    nominalCents: s.nominalCents,
    premiumCents: s.premiumCents,
  }));
}

/* ──────────────────────────────── 1011 ────────────────────────────────── */

/** Declaraciones del año agrupadas por formulario, con el concepto 1011 (o null). */
export function aggregate1011(filings: FilingInput[]): Row1011[] {
  const rows = new Map<string, Row1011>();
  for (const f of filings) {
    const cur = rows.get(f.form) ?? {
      form: f.form,
      concept: CONCEPTO_1011_POR_FORMULARIO[f.form] ?? null,
      valueCents: 0,
      count: 0,
    };
    cur.valueCents += f.declaredCents;
    cur.count += 1;
    rows.set(f.form, cur);
  }
  return [...rows.values()].sort((a, b) => a.form.localeCompare(b.form));
}

/* ──────────────────────────────── 1012 ────────────────────────────────── */

export function rows1012(holdings: HoldingInput[]): Row1012[] {
  return holdings.map((h) => ({
    id: h.id,
    concept: h.concept,
    tercero: manualTercero(`ho:${h.id}`, h.entityName, h.entityDocType, h.entityDocNumber, null),
    valueCents: h.valueCents,
  }));
}

/* ──────────────────────────────── 2276 ────────────────────────────────── */

/**
 * Rentas de trabajo por empleado desde los conceptos liquidados del año:
 * salario (`salario`), otros devengados (recargos, auxilio de transporte…),
 * salud y pensión del empleado (deducciones) y retefuente si algún día
 * existe el concepto (`retefuente`). Aportes del empleador y provisiones no
 * son renta del trabajador y se ignoran.
 */
export function aggregate2276(items: PayrollItemInput[]): Row2276[] {
  const rows = new Map<string, Row2276>();
  for (const it of items) {
    const cur = rows.get(it.employeeId) ?? {
      employeeId: it.employeeId,
      name: it.employeeName,
      salarioCents: 0,
      otrosCents: 0,
      saludCents: 0,
      pensionCents: 0,
      retefuenteCents: 0,
    };
    if (it.kind === "devengado") {
      if (it.conceptKey === "salario") cur.salarioCents += it.amountCents;
      else cur.otrosCents += it.amountCents;
    } else if (it.kind === "deduccion") {
      if (it.conceptKey === "salud_empleado") cur.saludCents += it.amountCents;
      else if (it.conceptKey === "pension_empleado") cur.pensionCents += it.amountCents;
      else if (/retef|retencion|retención/i.test(it.conceptKey)) cur.retefuenteCents += it.amountCents;
    }
    rows.set(it.employeeId, cur);
  }
  return [...rows.values()]
    .filter((r) => r.salarioCents > 0 || r.otrosCents > 0)
    .sort(byTotalDesc((r) => r.salarioCents + r.otrosCents));
}

/* ───────────────────────────── Incidencias ────────────────────────────── */

type TerceroRow = { tercero: Tercero; amountCents: number };

function terceroIssues(format: FormatoExogena, rows: TerceroRow[]): ExogenaIssue[] {
  const out: ExogenaIssue[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.tercero.key === "cf") continue;
    const res = resolveTerceroDoc(r.tercero);
    const code = res.issue ?? res.warning;
    if (!code) continue;
    const k = `${format}:${r.tercero.key}:${code}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      format,
      code,
      name: r.tercero.name,
      amountCents: rows
        .filter((x) => x.tercero.key === r.tercero.key)
        .reduce((s, x) => s + x.amountCents, 0),
      href: r.tercero.href,
      blocking: res.issue !== null,
    });
  }
  return out;
}

/* ─────────────────────────────── Reporte ──────────────────────────────── */

export type ExogenaFormats = {
  "1001": Row1001[];
  "1005": Row1005[];
  "1006": Row1006[];
  "1007": Row1007[];
  "1008": RowSaldo[];
  "1009": RowSaldo[];
  "1010": Row1010[];
  "1011": Row1011[];
  "1012": Row1012[];
  "2276": Row2276[];
};

export type ExogenaInputs = {
  purchases: PurchaseInput[];
  expenses: ExpenseInput[];
  sales: SaleInput[];
  receivables: ReceivableInput[];
  payables: PayableInput[];
  filings: FilingInput[];
  payroll: PayrollItemInput[];
  shareholders: ShareholderInput[];
  holdings: HoldingInput[];
};

export type ExogenaReport = {
  formats: ExogenaFormats;
  totals: Record<FormatoExogena, number>;
  issues: ExogenaIssue[];
};

/** Todas las tablas + incidencias a partir de las filas planas. */
export function buildExogenaReport(i: ExogenaInputs): ExogenaReport {
  const formats: ExogenaFormats = {
    "1001": aggregate1001({ purchases: i.purchases, expenses: i.expenses }),
    "1005": aggregate1005(i.purchases),
    "1006": aggregate1006(i.sales),
    "1007": aggregate1007(i.sales),
    "1008": aggregate1008(i.receivables),
    "1009": aggregate1009(i.payables),
    "1010": rows1010(i.shareholders),
    "1011": aggregate1011(i.filings),
    "1012": rows1012(i.holdings),
    "2276": aggregate2276(i.payroll),
  };
  const sum = (ns: number[]) => ns.reduce((s, n) => s + n, 0);
  const totals: Record<FormatoExogena, number> = {
    "1001": sum(formats["1001"].map((r) => r.pagoCents)),
    "1005": sum(formats["1005"].map((r) => r.vimpCents)),
    "1006": sum(formats["1006"].map((r) => r.ivaCents + r.incCents)),
    "1007": sum(formats["1007"].map((r) => r.ibruCents)),
    "1008": sum(formats["1008"].map((r) => r.saldoCents)),
    "1009": sum(formats["1009"].map((r) => r.saldoCents)),
    "1010": sum(formats["1010"].map((r) => r.nominalCents + r.premiumCents)),
    "1011": sum(formats["1011"].filter((r) => r.concept).map((r) => r.valueCents)),
    "1012": sum(formats["1012"].map((r) => r.valueCents)),
    "2276": sum(formats["2276"].map((r) => r.salarioCents + r.otrosCents)),
  };

  const issues: ExogenaIssue[] = [
    ...terceroIssues("1001", formats["1001"].map((r) => ({ tercero: r.tercero, amountCents: r.pagoCents }))),
    ...terceroIssues("1005", formats["1005"].map((r) => ({ tercero: r.tercero, amountCents: r.vimpCents }))),
    ...terceroIssues("1006", formats["1006"].map((r) => ({ tercero: r.tercero, amountCents: r.ivaCents + r.incCents }))),
    ...terceroIssues("1007", formats["1007"].map((r) => ({ tercero: r.tercero, amountCents: r.ibruCents }))),
    ...terceroIssues("1008", formats["1008"].map((r) => ({ tercero: r.tercero, amountCents: r.saldoCents }))),
    ...terceroIssues("1009", formats["1009"].map((r) => ({ tercero: r.tercero, amountCents: r.saldoCents }))),
    ...terceroIssues("1010", formats["1010"].map((r) => ({ tercero: r.tercero, amountCents: r.nominalCents }))),
    ...terceroIssues("1012", formats["1012"].map((r) => ({ tercero: r.tercero, amountCents: r.valueCents }))),
    // 1011: formularios sin concepto no van al XML (no bloquea; se informa).
    ...formats["1011"]
      .filter((r) => !r.concept)
      .map<ExogenaIssue>((r) => ({
        format: "1011",
        code: "missing_concept",
        name: r.form,
        amountCents: r.valueCents,
        href: null,
        blocking: false,
      })),
    // 2276: los empleados no tienen documento en MESAPAY; sin XML.
    ...formats["2276"].map<ExogenaIssue>((r) => ({
      format: "2276",
      code: "employee_missing_doc",
      name: r.name,
      amountCents: r.salarioCents + r.otrosCents,
      href: "/operator/horarios",
      blocking: false,
    })),
  ];
  return { formats, totals, issues };
}
