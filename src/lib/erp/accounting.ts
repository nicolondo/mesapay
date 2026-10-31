// Contabilidad operativa (ERP Fase B2) — LÓGICA PURA, sin DB.
//
// El caller (API) consulta los agregados (ventas, consumo, mermas,
// gastos, compras) y acá se arma el P&L, se serializa el CSV y se decide
// qué plantillas de gasto recurrente materializar. Todo en centavos
// enteros; los % con 1 decimal.

/** [desde, hasta) en UTC para un mes "YYYY-MM". null si el input no es válido. */
export function monthRange(month: string): { from: Date; to: Date } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const year = Number(m[1]);
  const mon = Number(m[2]);
  if (year < 2020 || year > 2100 || mon < 1 || mon > 12) return null;
  return {
    from: new Date(Date.UTC(year, mon - 1, 1)),
    to: new Date(Date.UTC(year, mon, 1)),
  };
}

/** % sobre base con 1 decimal; null si la base es 0 (no inventar 0%). */
export function pctOf(partCents: number, baseCents: number): number | null {
  if (baseCents === 0) return null;
  return Math.round((partCents / baseCents) * 1000) / 10;
}

// ── Impuestos (ERP A3): ventas + compras, para reportes al contador ─────────

export type SalesTaxKind = "none" | "inc" | "iva";

/**
 * Impuesto EMBEBIDO en un precio que ya lo incluye: si el precio final es
 * bruto = base × (1 + pct/100), el impuesto = bruto × pct/(100+pct). Así el
 * comensal paga lo mismo y se deriva el componente de impuesto para reportes.
 */
export function embeddedTaxCents(grossCents: number, pct: number): number {
  if (!(pct > 0) || grossCents <= 0) return 0;
  return Math.round((grossCents * pct) / (100 + pct));
}

/**
 * Un tramo del impuesto de ventas del mes: una tarifa (tipo + %) y lo que
 * causó. Un mes normal tiene un solo tramo; si el comercio cambió de
 * tarifa a mitad de mes hay dos, y el asiento tiene que poder llevar los
 * dos códigos (241205 para INC, el auxiliar por tarifa para IVA).
 */
export type SalesTaxSlice = {
  kind: SalesTaxKind;
  pct: number;
  /** Σ bruto de las ventas de este tramo (el precio ya incluye el impuesto). */
  grossCents: number;
  /** Impuesto embebido causado en este tramo. */
  taxCents: number;
  /** Base gravable = grossCents − taxCents. */
  baseCents: number;
};

/** Lo que una nota crédito o una devolución le resta a las ventas (positivo). */
export type SalesAdjustment = {
  /** Base + impuesto. */
  grossCents: number;
  baseCents: number;
  taxCents: number;
};

/** Impuesto de un tramo: bruto, lo que restaron notas y devoluciones, y el neto. */
export type NetSalesTaxSlice = {
  kind: SalesTaxKind;
  pct: number;
  grossTaxCents: number;
  creditNoteTaxCents: number;
  refundTaxCents: number;
  /** Neto = bruto − notas − devoluciones (puede ser negativo si devolviste más de lo que vendiste). */
  taxCents: number;
};

/** Orden estable de los tramos: IVA, INC; tarifa mayor primero. */
const NET_KIND_ORDER: Record<SalesTaxKind, number> = { iva: 0, inc: 1, none: 2 };

/**
 * Impuesto NETO por tarifa: el bruto que cada factura congeló menos lo que
 * declararon las notas crédito en esa tarifa y menos el impuesto estimado
 * de las devoluciones sin nota (que van al tramo del mes). Los tramos «sin
 * impuesto» no aparecen.
 */
export function netSalesTaxByRate(
  gross: readonly Pick<SalesTaxSlice, "kind" | "pct" | "taxCents">[],
  creditNotes: readonly Pick<SalesTaxSlice, "kind" | "pct" | "taxCents">[],
  refund: { kind: SalesTaxKind; pct: number; taxCents: number } | null,
): NetSalesTaxSlice[] {
  const byKey = new Map<string, NetSalesTaxSlice>();
  const slot = (kind: SalesTaxKind, pct: number) => {
    const key = `${kind}:${pct}`;
    const s = byKey.get(key) ?? {
      kind,
      pct,
      grossTaxCents: 0,
      creditNoteTaxCents: 0,
      refundTaxCents: 0,
      taxCents: 0,
    };
    byKey.set(key, s);
    return s;
  };
  for (const g of gross) if (g.kind !== "none" && g.taxCents !== 0) slot(g.kind, g.pct).grossTaxCents += g.taxCents;
  for (const n of creditNotes) if (n.kind !== "none" && n.taxCents !== 0) slot(n.kind, n.pct).creditNoteTaxCents += n.taxCents;
  if (refund && refund.kind !== "none" && refund.taxCents !== 0) slot(refund.kind, refund.pct).refundTaxCents += refund.taxCents;
  for (const s of byKey.values()) s.taxCents = s.grossTaxCents - s.creditNoteTaxCents - s.refundTaxCents;
  return [...byKey.values()].sort(
    (a, b) => NET_KIND_ORDER[a.kind] - NET_KIND_ORDER[b.kind] || b.pct - a.pct,
  );
}

/**
 * Devolución sin nota crédito: el impuesto se estima embebido con el tramo
 * del mes (la misma regla del asiento «Devoluciones del mes» y de
 * «Impuestos del período»).
 */
export function refundAdjustment(
  refundsCents: number,
  monthTax: { kind: SalesTaxKind; pct: number },
): SalesAdjustment {
  const grossCents = Math.max(0, refundsCents);
  const taxCents = monthTax.kind === "none" ? 0 : embeddedTaxCents(grossCents, monthTax.pct);
  return { grossCents, baseCents: grossCents - taxCents, taxCents };
}

/** Resumen de impuestos del mes: causados en ventas + pagados en compras. */
export type TaxSummary = {
  sales: {
    /**
     * Régimen con el que se ETIQUETA el mes: el del tramo que más impuesto
     * causó, o la configuración actual del comercio si ningún tramo causó
     * (así "none" sigue significando "sin impuesto configurado"). Para
     * contabilizar NO se usa esto sino `byRate`.
     */
    kind: SalesTaxKind;
    pct: number;
    /** Σ subtotales de órdenes pagadas (el precio ya incluye el impuesto). */
    grossCents: number;
    /** Impuesto embebido (INC + IVA) causado en ventas: Σ de `byRate`. */
    taxCents: number;
    /** Base gravable = grossCents − taxCents. */
    baseCents: number;
    /** Tramos con impuesto (kind ≠ none y taxCents > 0), de mayor a menor. */
    byRate: SalesTaxSlice[];
    /**
     * Notas crédito ACEPTADAS por la DIAN con fecha fiscal en el mes (lo
     * que restan). Mismo corte que el libro de ventas y que «Impuestos del
     * período». Montos positivos.
     */
    creditNotes: SalesAdjustment & { count: number };
    /**
     * Reembolsos de la pasarela del mes SIN nota crédito ligada: impuesto
     * estimado con el tramo del mes (`kind`/`pct`), igual que el asiento
     * «Devoluciones del mes». Montos positivos.
     */
    refunds: SalesAdjustment;
    /** Bruto − notas crédito − devoluciones: lo que se declara. */
    net: {
      baseCents: number;
      taxCents: number;
      byRate: NetSalesTaxSlice[];
    };
  };
  purchases: {
    /** IVA pagado en compras (Σ por línea desde taxPct). */
    ivaCents: number;
    /** INC/impoconsumo pagado en compras. */
    incCents: number;
    retefuenteCents: number;
    reteIvaCents: number;
    reteIcaCents: number;
  };
};

/**
 * De dónde salen los ingresos por ventas del PYG. Todo positivo; los
 * ingresos son `netSalesCents(detail)`.
 */
export type SalesDetail = {
  /** Σ subtotal de las cuentas cobradas: precio de carta (los platos llevan el impuesto adentro). */
  listCents: number;
  /** Σ descuento del comensal. */
  discountCents: number;
  /** Impuesto incluido en el precio de los platos (INC/IVA): el bruto del resumen de impuestos. */
  includedTaxCents: number;
  /** Base (sin impuesto) de las notas crédito aceptadas con fecha fiscal en el mes. */
  creditNotesCents: number;
  /** Base (sin impuesto) de los reembolsos del mes sin nota crédito. */
  refundsCents: number;
};

/**
 * Ingresos por ventas: lo cobrado sin propina ni impuesto, neto de
 * descuentos, menos notas crédito y devoluciones. Es lo que el motor lleva
 * a 4135 menos lo que debita a 4175 (devoluciones en ventas).
 */
export function netSalesCents(d: SalesDetail): number {
  return d.listCents - d.discountCents - d.includedTaxCents - d.creditNotesCents - d.refundsCents;
}

/**
 * Reparte las ventas netas del mes (ANTES de notas y devoluciones, que no
 * tienen categoría) entre las categorías de la carta: el descuento en
 * proporción al precio de carta de cada una y el impuesto incluido en
 * proporción a sus platos de carta (las líneas libres llevan el impuesto
 * aparte). Resto mayor: la suma cuadra al centavo con
 * `listCents − discountCents − includedTaxCents`.
 */
export function netCategorySales(
  categories: readonly { category: string; listCents: number; menuListCents: number }[],
  totals: { discountCents: number; includedTaxCents: number },
): Map<string, number> {
  const list = categories.reduce((s, c) => s + c.listCents, 0);
  const menu = categories.reduce((s, c) => s + c.menuListCents, 0);
  const exact = categories.map((c, i) => {
    const discount = list > 0 ? (totals.discountCents * c.listCents) / list : 0;
    // Sin platos de carta (sólo líneas libres) el impuesto, si lo hubiera,
    // se reparte por precio de carta para que la suma siga cuadrando.
    const tax =
      menu > 0
        ? (totals.includedTaxCents * c.menuListCents) / menu
        : list > 0
          ? (totals.includedTaxCents * c.listCents) / list
          : 0;
    const value = c.listCents - discount - tax;
    return { i, floor: Math.floor(value), rest: value - Math.floor(value) };
  });
  const target = list > 0 ? list - totals.discountCents - totals.includedTaxCents : 0;
  let left = target - exact.reduce((s, e) => s + e.floor, 0);
  for (const e of [...exact].sort((a, b) => b.rest - a.rest || a.i - b.i)) {
    if (left <= 0) break;
    e.floor += 1;
    left -= 1;
  }
  return new Map(exact.map((e) => [categories[e.i]!.category, e.floor]));
}

export type PnlInputs = {
  /**
   * Ingresos por ventas del mes: `netSalesCents(salesDetail)` — sin
   * impuesto ni propina, neto de descuentos, notas crédito y devoluciones.
   */
  salesCents: number;
  /** Cómo se llega a `salesCents` (null en los consumidores viejos). */
  salesDetail?: SalesDetail | null;
  /** Σ tipCents (informativo — no es ingreso del negocio). */
  tipsCents: number;
  /**
   * Σ Order.taxCents: impuesto que las líneas libres SUMAN encima de su
   * precio (informativo — no está en el subtotal, así que tampoco en los
   * ingresos).
   */
  taxesCents: number;
  /** Σ |valueCents| de sale_consumption del mes (ledger A4). */
  consumptionCents: number;
  /** Σ |valueCents| de waste del mes. */
  wasteCents: number;
  /** Gastos del mes por categoría. */
  expensesByCategory: Array<{ category: string; amountCents: number; source?: "non_inventory_purchases" }>;
  /** Σ recibido de OCs del mes (informativo — el costo entra vía CMV). */
  purchasesReceivedCents: number;
  /**
   * C1 — costo laboral del mes (null = módulo staff apagado: el P&L no
   * cambia). Base = Σ salarios mensuales de los empleados activos (fija);
   * encima, recargos festivo/dominical de los turnos.
   */
  labor?: LaborSummary | null;
};

export type LaborSummary = {
  /** Base salarial + recargos. */
  totalCents: number;
  /** Σ salarios mensuales de empleados activos con salario (base fija). */
  baseSalaryCents: number;
  /** C2 — Σ recargos festivo/dominical de los turnos del mes. */
  surchargeCents: number;
  /** Empleados contados en la base. */
  salariedEmployees: number;
  /** Empleados activos sin salario (badge en UI; no aportan a la base). */
  missingSalaryEmployees: number;
  shifts: number;
  /** C2 — faltas del mes (modo estricto). */
  absentShifts: number;
};

/** Ventas y CMV de una categoría del menú (para el desglose del P&L). */
export type CategoryLine = {
  category: string;
  salesCents: number;
  cmvCents: number;
};

export type Pnl = PnlInputs & {
  expensesCents: number;
  grossProfitCents: number;
  grossMarginPct: number | null;
  operatingProfitCents: number;
  operatingMarginPct: number | null;
  /** C1 — (CMV + mermas + laboral) / ingresos. null sin módulo staff o sin ventas. */
  primeCostPct: number | null;
  /** Ventas y CMV por categoría del menú (vacío si no hay ventas). */
  categoryBreakdown: CategoryLine[];
};

export function buildPnl(i: PnlInputs): Pnl {
  const expensesCents = i.expensesByCategory.reduce(
    (s, e) => s + e.amountCents,
    0,
  );
  const grossProfitCents = i.salesCents - i.consumptionCents - i.wasteCents;
  const laborCents = i.labor?.totalCents ?? 0;
  const operatingProfitCents = grossProfitCents - laborCents - expensesCents;
  return {
    ...i,
    salesDetail: i.salesDetail ?? null,
    labor: i.labor ?? null,
    expensesByCategory: [...i.expensesByCategory].sort(
      (a, b) => b.amountCents - a.amountCents,
    ),
    expensesCents,
    grossProfitCents,
    grossMarginPct: pctOf(grossProfitCents, i.salesCents),
    operatingProfitCents,
    operatingMarginPct: pctOf(operatingProfitCents, i.salesCents),
    primeCostPct: i.labor
      ? pctOf(i.consumptionCents + i.wasteCents + laborCents, i.salesCents)
      : null,
    // Lo llena la capa de datos (necesita DB); acá default vacío.
    categoryBreakdown: [],
  };
}

// ── CSV (RFC 4180 + BOM para Excel) ────────────────────────────────────────

function csvCell(v: string | number | null | undefined): string {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Serializa filas a CSV con BOM UTF-8 (Excel muestra bien los acentos).
 * Montos: el caller ya los convierte a unidades de moneda (no centavos).
 */
export function toCsv(
  headers: string[],
  rows: Array<Array<string | number | null | undefined>>,
): string {
  const lines = [headers, ...rows].map((r) => r.map(csvCell).join(","));
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}

/** Centavos → unidades de moneda con 2 decimales y punto (para CSV). */
export function centsToCsvAmount(cents: number): string {
  return (cents / 100).toFixed(2);
}

// ── Excel multi-hoja (SpreadsheetML 2003, SIN dependencias) ─────────────────
// Un solo XML de texto que Excel y Google Sheets abren como libro con varias
// hojas. Evita agregar una librería (exceljs) y el riesgo de build en deploy.
// Los montos van como Number (el contador puede sumar/filtrar).

export type XlsxSheet = {
  name: string;
  headers: string[];
  rows: Array<Array<string | number | null | undefined>>;
};

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function xlsxCell(v: string | number | null | undefined): string {
  if (v == null || v === "") return "<Cell/>";
  if (typeof v === "number" && isFinite(v)) {
    return `<Cell><Data ss:Type="Number">${v}</Data></Cell>`;
  }
  return `<Cell><Data ss:Type="String">${xmlEscape(String(v))}</Data></Cell>`;
}

/** Nombre de hoja válido para Excel: ≤31 chars, sin : \ / ? * [ ]. */
function sheetName(name: string): string {
  return xmlEscape(name.replace(/[:\\/?*[\]]/g, " ").slice(0, 31));
}

/**
 * Serializa hojas a un libro SpreadsheetML 2003. Se sirve como
 * `application/vnd.ms-excel` con extensión .xls. Excel muestra un aviso
 * benigno de "formato/extensión" que se acepta con un clic.
 */
export function buildXlsxWorkbook(sheets: XlsxSheet[]): string {
  const body = sheets
    .map((s) => {
      const rows = [s.headers, ...s.rows]
        .map((r) => `<Row>${r.map(xlsxCell).join("")}</Row>`)
        .join("");
      return `<Worksheet ss:Name="${sheetName(s.name)}"><Table>${rows}</Table></Worksheet>`;
    })
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<?mso-application progid="Excel.Sheet"?>\n` +
    `<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" ` +
    `xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">${body}</Workbook>`
  );
}

/** Centavos → número en unidades de moneda (2 decimales) para celdas Excel. */
export function centsToAmount(cents: number): number {
  return Math.round(cents) / 100;
}

// ── Gastos recurrentes ──────────────────────────────────────────────────────

export type RecurringTemplate = {
  id: string;
  recurringDay: number;
};

/**
 * Qué plantillas tocan HOY y aún no tienen copia este mes. Pura: el cron
 * consulta plantillas + copias del mes y escribe las que salgan de acá.
 *
 * Regla del día: materializa cuando day-of-month (UTC) == recurringDay.
 * recurringDay se valida 1-28 en la API, así que todos los meses tienen
 * el día — sin casos de febrero.
 */
export function materializeRecurring(
  templates: RecurringTemplate[],
  copiesThisMonthByTemplateId: Set<string>,
  today: Date,
): string[] {
  const day = today.getUTCDate();
  return templates
    .filter(
      (t) => t.recurringDay === day && !copiesThisMonthByTemplateId.has(t.id),
    )
    .map((t) => t.id);
}

/** Split received purchases using the classification frozen at each reception.
 * INC follows the same net-cost proportion; the remainder stays in inventory
 * so integer rounding never changes the total supplier obligation.
 */
export function splitPurchaseInventoryCost(args: {
  receivedCents: number;
  nonInventoryReceivedCents: number;
  incCents: number;
  /** Consumo ya asignado a líneas; no volver a prorratearlo. */
  allocatedIncCents?: number;
  /** Parte de ese consumo congelada como no inventariable al recibir. */
  nonInventoryAllocatedIncCents?: number;
}) {
  const unallocatedInc = Math.max(0, args.incCents - (args.allocatedIncCents ?? 0));
  const nonInventoryIncCents = (args.nonInventoryAllocatedIncCents ?? 0) + (args.receivedCents > 0
    ? Number((BigInt(unallocatedInc) * BigInt(args.nonInventoryReceivedCents)
        + BigInt(args.receivedCents) / BigInt(2)) / BigInt(args.receivedCents))
    : 0);
  const expenseCents = args.nonInventoryReceivedCents + nonInventoryIncCents;
  return {
    nonInventoryIncCents,
    expenseCents,
    inventoryCents: args.receivedCents + args.incCents - expenseCents,
  };
}
