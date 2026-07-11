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

/** Resumen de impuestos del mes: causados en ventas + pagados en compras. */
export type TaxSummary = {
  sales: {
    kind: SalesTaxKind;
    pct: number;
    /** Σ subtotales de órdenes pagadas (el precio ya incluye el impuesto). */
    grossCents: number;
    /** Componente de impuesto embebido (INC o IVA) causado en ventas. */
    taxCents: number;
    /** Base gravable = grossCents − taxCents. */
    baseCents: number;
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

export type PnlInputs = {
  /** Σ subtotalCents de órdenes pagadas del mes. */
  salesCents: number;
  /** Σ tipCents (informativo — no es ingreso del negocio). */
  tipsCents: number;
  /** Σ taxCents (informativo — el IVA formal llega con B1). */
  taxesCents: number;
  /** Σ |valueCents| de sale_consumption del mes (ledger A4). */
  consumptionCents: number;
  /** Σ |valueCents| de waste del mes. */
  wasteCents: number;
  /** Gastos del mes por categoría. */
  expensesByCategory: Array<{ category: string; amountCents: number }>;
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
